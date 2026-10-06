/**
 * Rigel native V2 todo-continuation decision gate.
 *
 * Pure port of the gate half of the V1 `todo-continuation-enforcer` idle
 * handler (`packages/omo-opencode/src/hooks/todo-continuation-enforcer/idle-event.ts`):
 * given a fully resolved snapshot of a session, decide whether an internal
 * continuation prompt should be injected now, and name the blocking condition
 * when it should not.
 *
 * The V2 runtime resolves every observable fact (background work, pending
 * questions, last-assistant abort, compaction guard, continuation stop) before
 * calling this predicate, so the predicate itself stays pure: no I/O, no clock
 * reads, no mutation. `now` is injected and the per-session `state` object is
 * read-only here. The side effects the V1 handler performed between gates
 * (clearing `abortDetectedAt`, resetting `consecutiveFailures` after
 * `FAILURE_RESET_WINDOW_MS`, acknowledging the compaction guard, arming the
 * countdown) belong to the caller that owns the state store.
 *
 * Gate order is the contract pinned by the co-located test. The first matching
 * skip wins, and `{ action: "continue", reason: "ok" }` is the fallthrough.
 */

export const MAX_STAGNATION_COUNT = 3
export const MAX_CONSECUTIVE_FAILURES = 5
export const FAILURE_RESET_WINDOW_MS = 5 * 60 * 1000
export const CONTINUATION_COOLDOWN_MS = 5000
export const COMPACTION_GUARD_MS = 60000
export const ABORT_WINDOW_MS = 3000
export const COUNTDOWN_SECONDS = 2
export const DEFAULT_SKIP_AGENTS = ["prometheus", "compaction", "plan"]

function skip(reason) {
  return { action: "skip", reason }
}

/**
 * Decide whether the V2 runtime should inject a todo-continuation prompt.
 *
 * @param {object} [snapshot]
 * @param {object} [snapshot.state] Per-session continuation state
 *   (`createNativeTodoContinuationState().getState(sessionID)`): carries
 *   `allTodosCompletedAt`, `isRecovering`, `wasCancelled`, `tokenLimitDetected`,
 *   `unrecoverableErrorDetected`, `abortDetectedAt`, and `inFlight`.
 * @param {Array} [snapshot.todos] The session's todo list.
 * @param {number} [snapshot.incompleteCount] Outstanding todo count.
 * @param {boolean} [snapshot.hasBackgroundWork] Running/pending background tasks
 *   or a pending parent wake.
 * @param {boolean} [snapshot.hasPendingQuestion] A question tool is blocking.
 * @param {boolean} [snapshot.hasUnansweredQuestion] An unanswered question tool
 *   part was observed in the latest turn.
 * @param {boolean} [snapshot.isLastAssistantAborted] Latest assistant message
 *   ended in an abort error.
 * @param {boolean} [snapshot.isCompactionGuardActive] The post-compaction guard
 *   is still armed for the current epoch.
 * @param {string[]} [snapshot.skipAgents] Agents that must never be continued.
 * @param {string} [snapshot.resolvedAgent] The agent owning the latest turn.
 * @param {boolean} [snapshot.isContinuationStopped] Manual stop applied.
 * @param {number} [snapshot.stagnationCount] No-progress observation count.
 * @param {number} [snapshot.consecutiveFailures] Failed-injection count; scales
 *   the cooldown and caps continuation.
 * @param {number} [snapshot.lastInjectedAt] Timestamp of the last injection.
 * @param {number} [snapshot.now] Injected clock.
 * @returns {{ action: "continue" | "skip", reason: string }}
 */
export function decideTodoContinuation(snapshot = {}) {
  const {
    state = {},
    todos,
    incompleteCount,
    hasBackgroundWork = false,
    hasPendingQuestion = false,
    isLastAssistantAborted = false,
    hasUnansweredQuestion = false,
    isCompactionGuardActive = false,
    skipAgents,
    resolvedAgent,
    isContinuationStopped = false,
    stagnationCount = 0,
    consecutiveFailures = 0,
    lastInjectedAt,
    now = 0,
  } = snapshot

  // 1-5: terminal per-session conditions recorded by the runtime.
  if (state.allTodosCompletedAt) return skip("all todos completed")
  if (state.isRecovering) return skip("in recovery")
  if (state.wasCancelled) return skip("session was cancelled")
  if (state.tokenLimitDetected) return skip("token limit detected")
  if (state.unrecoverableErrorDetected) return skip("unrecoverable error detected")

  // 6: an abort inside the window means the user just interrupted.
  if (state.abortDetectedAt != null && now - state.abortDetectedAt < ABORT_WINDOW_MS) {
    return skip("abort detected")
  }

  // 7-9: externally resolved blockers.
  if (hasBackgroundWork) return skip("background work active")
  if (hasPendingQuestion || hasUnansweredQuestion) return skip("pending question")
  if (isLastAssistantAborted) return skip("last assistant message aborted")

  // 10-11: nothing to continue.
  if (!Array.isArray(todos) || todos.length === 0) return skip("no todos")
  if (incompleteCount === 0) return skip("all todos complete")

  // 12: a countdown/injection is already scheduled.
  if (state.inFlight) return skip("injection in flight")

  // 13: too many failed injections.
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return skip("max consecutive failures")

  // 14: exponential cooldown after a successful injection.
  const effectiveCooldown = CONTINUATION_COOLDOWN_MS * 2 ** Math.min(consecutiveFailures, 5)
  if (lastInjectedAt != null && now - lastInjectedAt < effectiveCooldown) {
    return skip("cooldown active")
  }

  // 15: post-compaction guard still armed for the current epoch.
  if (isCompactionGuardActive) return skip("compaction guard active")

  // 16: the owning agent opted out of continuation.
  const agents = Array.isArray(skipAgents) ? skipAgents : DEFAULT_SKIP_AGENTS
  if (resolvedAgent != null && agents.includes(resolvedAgent)) return skip("agent in skip list")

  // 17: manual stop for this session.
  if (isContinuationStopped) return skip("continuation stopped")

  // 18: no progress across MAX_STAGNATION_COUNT observations.
  if (stagnationCount >= MAX_STAGNATION_COUNT) return skip("stagnation limit")

  return { action: "continue", reason: "ok" }
}
