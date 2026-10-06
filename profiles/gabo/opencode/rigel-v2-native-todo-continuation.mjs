/**
 * Native V2 todo-continuation enforcer for Oh My Rigel.
 *
 * Faithful port of the V1 `todo-continuation-enforcer` idle handler
 * (`packages/omo-opencode/src/hooks/todo-continuation-enforcer/`): it reads the
 * real session todo registry, the session transcript and the owning agent,
 * consults the pure decision gate, and injects the V1 continuation directive
 * when the session went idle with incomplete todos and no real blocker.
 *
 * The gate stays a pure predicate. THIS module owns every side effect the gate
 * documents as belonging to its caller: progress/stagnation tracking, the
 * compaction guard epoch, the abort / token-limit / unrecoverable flags, the
 * countdown and `inFlight` exclusivity, the post-injection progress check, and
 * the consecutive-failure counter with its reset window. Every external fact it
 * needs is injected, so the module is testable without a live host.
 *
 * Shape tolerance: the V2 session transcript is `{ data: [{ type, content }] }`
 * and the V2 event stream carries `{ properties }`/`{ data }` records. The
 * extractors below accept both the `content` and `parts` spellings, because the
 * two V2 surfaces differ.
 */
import {
  CONTINUATION_COOLDOWN_MS,
  COUNTDOWN_SECONDS,
  DEFAULT_SKIP_AGENTS,
  FAILURE_RESET_WINDOW_MS,
  MAX_CONSECUTIVE_FAILURES,
  COMPACTION_GUARD_MS,
  decideTodoContinuation,
} from "./rigel-v2-native-todo-continuation-gate.mjs"
import { createNativeTodoContinuationState } from "./rigel-v2-native-todo-continuation-state.mjs"
import { buildContinuationPrompt } from "./rigel-v2-todo-continuation-prompt.mjs"
import { isV2OutputActivity, isV2UserActivity } from "./rigel-v2-native-activity.mjs"

const QUESTION_TOOLS = new Set(["question", "ask_user_question", "askuserquestion"])
const TERMINAL_TOOL_STATUSES = new Set(["completed", "error", "cancelled"])
const ABORT_ERROR_NAMES = new Set(["MessageAbortedError", "AbortError"])
const TOKEN_LIMIT_PATTERN = /(?:prompt is too long|context length|token limit|maximum context)/i
const UNRECOVERABLE_PATTERN = /(?:unrecoverable|invalid_request_error|invalid api key|authentication_error|permission_error)/i

export {
  CONTINUATION_COOLDOWN_MS,
  COUNTDOWN_SECONDS,
  DEFAULT_SKIP_AGENTS,
  FAILURE_RESET_WINDOW_MS,
  MAX_CONSECUTIVE_FAILURES,
  COMPACTION_GUARD_MS,
}

/** Normalize the `session.context` / `session.list` envelope to a message array. */
export function sessionMessageList(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.data)) return result.data
  return []
}

function roleOf(message) {
  const role = message?.type ?? message?.role ?? message?.info?.role
  return typeof role === "string" ? role.toLowerCase() : undefined
}

function partsOf(message) {
  if (Array.isArray(message?.parts)) return message.parts
  if (Array.isArray(message?.content)) return message.content
  return []
}

function toolNameOf(part) {
  const name = part?.tool ?? part?.name ?? part?.toolName
  return typeof name === "string" ? name.toLowerCase() : undefined
}

function isToolPart(part) {
  return part?.type === "tool" || part?.type === "tool_use" || part?.type === "tool-invocation"
}

function isUnansweredQuestionPart(part) {
  if (!isToolPart(part)) return false
  const name = toolNameOf(part)
  if (!name || !QUESTION_TOOLS.has(name)) return false
  const status = part?.state?.status
  return !TERMINAL_TOOL_STATUSES.has(status)
}

function isSyntheticUserMessage(message) {
  const role = roleOf(message)
  if (role === "synthetic" || role === "system") return true
  const parts = partsOf(message)
  if (parts.length === 0) return false
  return parts.every((part) => part?.synthetic === true)
}

function abortErrorName(value) {
  const name = value?.name ?? value?.type
  return typeof name === "string" ? name : undefined
}

/**
 * Read the latest assistant turn of a session transcript and report the
 * blockers the gate consumes: an unanswered `question` tool, a question tool
 * that ended the turn, and an abort error on the latest assistant message.
 */
export function analyzeSessionMessages(messages) {
  const list = sessionMessageList(messages)
  const result = { hasPendingQuestion: false, hasUnansweredQuestion: false, isLastAssistantAborted: false }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    const role = roleOf(message)
    if (role === "user") {
      if (isSyntheticUserMessage(message)) continue
      break
    }
    if (role !== "assistant") continue
    const parts = partsOf(message)
    const questionParts = parts.filter(isUnansweredQuestionPart)
    if (questionParts.length > 0) {
      result.hasUnansweredQuestion = true
      const lastPart = parts[parts.length - 1]
      result.hasPendingQuestion = isUnansweredQuestionPart(lastPart)
    }
    const errorName = abortErrorName(message?.info?.error ?? message?.error)
    if (typeof errorName === "string" && ABORT_ERROR_NAMES.has(errorName)) result.isLastAssistantAborted = true
    break
  }
  return result
}

function eventSessionID(event) {
  const sessionID = event?.sessionID ?? event?.data?.sessionID ?? event?.data?.session?.id ?? event?.properties?.sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}

function eventErrorName(event) {
  const name = event?.error?.name ?? event?.error?.type ?? event?.data?.error?.name ?? event?.data?.error?.type ?? event?.properties?.error?.name ?? event?.properties?.error?.type
  return typeof name === "string" ? name : undefined
}

function eventErrorMessage(event) {
  const value = event?.error?.message ?? event?.data?.error?.message ?? event?.properties?.error?.message ?? event?.properties?.message
  return typeof value === "string" ? value : ""
}

function isCompactionEvent(type) {
  return type === "session.compacted"
    || type === "session.compaction.started"
    || type === "session.compaction.ended"
    || type === "session.next.compaction.started"
    || type === "session.next.compaction.ended"
}

/**
 * Build the todo-continuation enforcer.
 *
 * Injected dependencies:
 * - `readTodos(sessionID)` -> the durable per-session todo list.
 * - `getMessages(sessionID)` -> the session transcript (`session.context`).
 * - `resolveAgent({ sessionID })` -> the owning agent name (`session.get`).
 * - `backgroundManager` -> `{ activeCount(sessionID) }` for the background blocker.
 * - `isContinuationStopped(sessionID)` -> the manual-stop flag.
 * - `dispatch({ sessionID, text })` -> the internal continuation prompt.
 * - `now`, `schedule`, `clearSchedule`, `countdownMs`, `skipAgents`, `onError`.
 */
export function createNativeTodoContinuationEnforcer({
  readTodos,
  getMessages,
  resolveAgent,
  backgroundManager,
  isContinuationStopped,
  dispatch,
  skipAgents = DEFAULT_SKIP_AGENTS,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  clearSchedule = (handle) => clearTimeout(handle),
  unrefTimer = (handle) => { if (handle && typeof handle.unref === "function") handle.unref() },
  countdownMs = COUNTDOWN_SECONDS * 1000,
  onError = console.error,
} = {}) {
  if (typeof dispatch !== "function") throw new TypeError("createNativeTodoContinuationEnforcer requires a dispatch function")
  const state = createNativeTodoContinuationState()

  function isCompactionGuardActive(sessionID) {
    const current = state.getState(sessionID)
    if (current.recentCompactionAt === undefined || current.recentCompactionEpoch === undefined) return false
    if (current.acknowledgedCompactionEpoch === current.recentCompactionEpoch) return false
    return now() - current.recentCompactionAt < COMPACTION_GUARD_MS
  }

  function armCompactionGuard(sessionID) {
    const current = state.getState(sessionID)
    current.recentCompactionAt = now()
    current.recentCompactionEpoch = (current.recentCompactionEpoch ?? 0) + 1
  }

  async function readSnapshot(sessionID) {
    const current = state.getState(sessionID)
    const todos = (typeof readTodos === "function" ? await readTodos(sessionID) : []) ?? []
    const incompleteCount = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length
    let analysis = { hasPendingQuestion: false, hasUnansweredQuestion: false, isLastAssistantAborted: false }
    if (typeof getMessages === "function") {
      try {
        analysis = analyzeSessionMessages(await getMessages(sessionID))
      } catch (error) {
        onError(`[oh-my-rigel] todo-continuation transcript read failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let agent
    if (typeof resolveAgent === "function") {
      try {
        agent = await resolveAgent({ sessionID })
      } catch (error) {
        onError(`[oh-my-rigel] todo-continuation agent resolve failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { current, todos, incompleteCount, analysis, agent }
  }

  function evaluate(sessionID, snapshot) {
    const { current, todos, incompleteCount, analysis, agent } = snapshot
    if (
      current.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
      && current.lastInjectedAt !== undefined
      && now() - current.lastInjectedAt >= FAILURE_RESET_WINDOW_MS
    ) {
      current.consecutiveFailures = 0
    }
    const progress = state.trackContinuationProgress(sessionID, incompleteCount, todos)
    if (incompleteCount === 0 && todos.length > 0) {
      if (current.allTodosCompletedAt === undefined) current.allTodosCompletedAt = now()
    }
    if (current.allTodosCompletedAt !== undefined && incompleteCount > 0) {
      current.allTodosCompletedAt = undefined
    }
    const decision = decideTodoContinuation({
      sessionID,
      state: current,
      todos,
      incompleteCount,
      hasBackgroundWork: (backgroundManager?.activeCount?.(sessionID) ?? 0) > 0,
      hasPendingQuestion: analysis.hasPendingQuestion,
      hasUnansweredQuestion: analysis.hasUnansweredQuestion,
      isLastAssistantAborted: analysis.isLastAssistantAborted,
      isCompactionGuardActive: isCompactionGuardActive(sessionID),
      skipAgents,
      resolvedAgent: agent,
      isContinuationStopped: isContinuationStopped?.(sessionID) ?? false,
      hasProgressed: progress.hasProgressed,
      stagnationCount: current.stagnationCount,
      consecutiveFailures: current.consecutiveFailures,
      lastInjectedAt: current.lastInjectedAt,
      now: now(),
    })
    if (decision.action === "continue" && agent && current.recentCompactionEpoch !== undefined) {
      current.acknowledgedCompactionEpoch = current.recentCompactionEpoch
    }
    return { decision, todos, incompleteCount }
  }

  async function inject(sessionID, todos, incompleteCount) {
    const current = state.getState(sessionID)
    current.inFlight = true
    try {
      await dispatch({ sessionID, text: buildContinuationPrompt({ todos, incompleteCount }) })
      current.lastInjectedAt = now()
      current.awaitingPostInjectionProgressCheck = true
      current.continuationResponseObserved = false
      current.consecutiveFailures = 0
      current.countdownStartedAt = undefined
    } catch (error) {
      current.lastInjectedAt = now()
      current.consecutiveFailures += 1
      current.countdownStartedAt = undefined
      onError(`[oh-my-rigel] todo-continuation injection failed: session=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      current.inFlight = false
    }
  }

  async function fire(sessionID) {
    const current = state.getState(sessionID)
    current.countdownTimer = undefined
    current.inFlight = false
    const snapshot = await readSnapshot(sessionID)
    const { decision, todos, incompleteCount } = evaluate(sessionID, snapshot)
    if (decision.action !== "continue") return { action: "skip", reason: decision.reason }
    await inject(sessionID, todos, incompleteCount)
    return { action: "continue", reason: "ok" }
  }

  async function handleIdle(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) return { action: "skip", reason: "no session" }
    const snapshot = await readSnapshot(sessionID)
    const { decision, todos, incompleteCount } = evaluate(sessionID, snapshot)
    if (decision.action !== "continue") return { action: "skip", reason: decision.reason }
    if (countdownMs <= 0) {
      await inject(sessionID, todos, incompleteCount)
      return { action: "continue", reason: "ok" }
    }
    const current = state.getState(sessionID)
    current.inFlight = true
    current.countdownStartedAt = now()
    current.countdownTimer = schedule(() => { void fire(sessionID) }, countdownMs)
    unrefTimer(current.countdownTimer)
    return { action: "continue", reason: "ok" }
  }

  function onEvent(event) {
    const sessionID = eventSessionID(event)
    if (!sessionID) return
    const type = event?.type
    if (type === "session.execution.interrupted") {
      const current = state.getState(sessionID)
      current.wasCancelled = true
      current.abortDetectedAt = now()
      state.cancelCountdown(sessionID)
      return
    }
    if (type === "session.error" || type === "session.execution.failed") {
      const current = state.getState(sessionID)
      const name = eventErrorName(event)
      const message = eventErrorMessage(event)
      if (name && ABORT_ERROR_NAMES.has(name)) {
        current.wasCancelled = true
        current.abortDetectedAt = now()
      } else if (TOKEN_LIMIT_PATTERN.test(message)) {
        current.tokenLimitDetected = true
      } else if (UNRECOVERABLE_PATTERN.test(message)) {
        current.unrecoverableErrorDetected = true
      }
      state.cancelCountdown(sessionID)
      return
    }
    if (isCompactionEvent(type)) {
      armCompactionGuard(sessionID)
      return
    }
    if (isV2OutputActivity(type) || isV2UserActivity(type) || type === "tool.execute.before" || type === "tool.execute.after") {
      const current = state.getExistingState(sessionID)
      if (current) {
        if (isV2UserActivity(type)) {
          // A new inbound user message is the V2 analogue of V1's
          // `message.updated` with `role === "user"`.
          if (current.awaitingPostInjectionProgressCheck === true) {
            current.continuationBlockReason = "user-interruption"
          }
        } else {
          // Assistant output (text/reasoning/tool/step) observed: the
          // continuation got a response. The V2 analogue of V1's
          // `message.part.delta` and assistant `message.updated`.
          current.continuationResponseObserved = current.awaitingPostInjectionProgressCheck === true
          current.abortDetectedAt = undefined
          current.wasCancelled = false
        }
      }
      state.cancelCountdown(sessionID)
      return
    }
  }

  return {
    handleIdle,
    onEvent,
    armCompactionGuard,
    isCompactionGuardActive,
    getState: (sessionID) => state.getState(sessionID),
    clear(sessionID) {
      state.cleanup(sessionID)
    },
    cancelAllCountdowns() {
      state.cancelAllCountdowns()
    },
    cancelCountdown(sessionID) {
      state.cancelCountdown(sessionID)
    },
    shutdown() {
      state.shutdown()
    },
  }
}
