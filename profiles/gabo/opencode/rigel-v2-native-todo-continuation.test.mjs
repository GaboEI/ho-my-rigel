import { describe, expect, test } from "bun:test"

import {
  analyzeSessionMessages,
  createNativeTodoContinuationEnforcer,
  DEFAULT_SKIP_AGENTS,
} from "./rigel-v2-native-todo-continuation.mjs"

const SESSION = "ses_continuation_test"

function todo(overrides = {}) {
  return { id: "t-1", content: "Do the work", status: "pending", priority: "medium", ...overrides }
}

function assistantTool(name, status = "pending", extra = {}) {
  return { type: "assistant", content: [{ type: "tool", tool: name, state: { status }, ...extra }] }
}

function assistantText(text = "working") {
  return { type: "assistant", content: [{ type: "text", text }] }
}

function harness(overrides = {}) {
  const dispatches = []
  let clock = 1_000_000
  const options = {
    readTodos: async () => [todo()],
    getMessages: async () => ({ data: [assistantText()] }),
    resolveAgent: async () => "sisyphus",
    backgroundManager: { activeCount: () => 0 },
    isContinuationStopped: () => false,
    dispatch: async (input) => { dispatches.push(input) },
    now: () => clock,
    countdownMs: 0,
    ...overrides,
  }
  const enforcer = createNativeTodoContinuationEnforcer(options)
  return {
    enforcer,
    dispatches,
    advance: (ms) => { clock += ms },
    setClock: (value) => { clock = value },
  }
}

describe("#given the session transcript analyzer", () => {
  describe("#when the latest assistant message holds an open question tool", () => {
    test("#then the unanswered and pending question predicates are both true", () => {
      const analysis = analyzeSessionMessages({ data: [assistantTool("question")] })
      expect(analysis.hasUnansweredQuestion).toBe(true)
      expect(analysis.hasPendingQuestion).toBe(true)
    })
  })

  describe("#when the question tool is already terminal", () => {
    test("#then no question blocker is reported", () => {
      const analysis = analyzeSessionMessages({ data: [assistantTool("question", "completed")] })
      expect(analysis.hasUnansweredQuestion).toBe(false)
      expect(analysis.hasPendingQuestion).toBe(false)
    })
  })

  describe("#when the latest assistant message carries an abort error", () => {
    test("#then the aborted predicate is true", () => {
      const message = { type: "assistant", info: { error: { name: "MessageAbortedError" } }, content: [] }
      expect(analyzeSessionMessages({ data: [message] }).isLastAssistantAborted).toBe(true)
    })
  })

  describe("#when a synthetic user message separates the turn", () => {
    test("#then it does not stop the scan before the assistant turn", () => {
      const synthetic = { type: "user", content: [{ type: "text", text: "internal", synthetic: true }] }
      const analysis = analyzeSessionMessages({ data: [assistantTool("question"), synthetic] })
      expect(analysis.hasUnansweredQuestion).toBe(true)
    })
  })
})

describe("#given the todo-continuation enforcer", () => {
  describe("#when the session is idle with incomplete todos and no blocker", () => {
    test("#then it injects exactly once and marks the post-injection check", async () => {
      const { enforcer, dispatches } = harness()

      const decision = await enforcer.handleIdle(SESSION)

      expect(decision.action).toBe("continue")
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]).toMatchObject({ sessionID: SESSION })
      expect(dispatches[0].text).toContain("TODO CONTINUATION")
      const state = enforcer.getState(SESSION)
      expect(state.lastInjectedAt).toBe(1_000_000)
      expect(state.awaitingPostInjectionProgressCheck).toBe(true)
      expect(state.consecutiveFailures).toBe(0)
    })
  })

  describe("#when a second idle arrives within the cooldown", () => {
    test("#then it is suppressed with no second injection", async () => {
      const { enforcer, dispatches } = harness()
      await enforcer.handleIdle(SESSION)

      const second = await enforcer.handleIdle(SESSION)

      expect(second).toEqual({ action: "skip", reason: "cooldown active" })
      expect(dispatches).toHaveLength(1)
    })
  })

  describe("#when the transcript holds a pending question", () => {
    test("#then the gate reads it and injects nothing", async () => {
      const { enforcer, dispatches } = harness({ getMessages: async () => ({ data: [assistantTool("question")] }) })

      const decision = await enforcer.handleIdle(SESSION)

      expect(decision).toEqual({ action: "skip", reason: "pending question" })
      expect(dispatches).toHaveLength(0)
    })
  })

  describe("#when the owning agent is in the skip list", () => {
    test("#then the gate skips on the resolved agent", async () => {
      const { enforcer, dispatches } = harness({ resolveAgent: async () => "prometheus" })

      const decision = await enforcer.handleIdle(SESSION)

      expect(decision).toEqual({ action: "skip", reason: "agent in skip list" })
      expect(dispatches).toHaveLength(0)
      expect(DEFAULT_SKIP_AGENTS).toContain("prometheus")
    })
  })

  describe("#when background work is active", () => {
    test("#then the gate skips on the live background count", async () => {
      const { enforcer, dispatches } = harness({ backgroundManager: { activeCount: () => 2 } })

      const decision = await enforcer.handleIdle(SESSION)

      expect(decision).toEqual({ action: "skip", reason: "background work active" })
      expect(dispatches).toHaveLength(0)
    })
  })

  describe("#when the session was manually stopped", () => {
    test("#then the gate skips on the stop flag", async () => {
      const { enforcer } = harness({ isContinuationStopped: () => true })

      expect(await enforcer.handleIdle(SESSION)).toEqual({ action: "skip", reason: "continuation stopped" })
    })
  })

  describe("#when an injection fails", () => {
    test("#then the consecutive-failure counter increments", async () => {
      const { enforcer } = harness({ dispatch: async () => { throw new Error("boom") } })

      await enforcer.handleIdle(SESSION)

      expect(enforcer.getState(SESSION).consecutiveFailures).toBe(1)
    })
  })

  describe("#when a success is followed by a no-progress observation", () => {
    test("#then progress tracking is consumed and stagnation increments", async () => {
      const { enforcer, advance } = harness()
      await enforcer.handleIdle(SESSION)

      advance(6_000)
      await enforcer.handleIdle(SESSION)

      expect(enforcer.getState(SESSION).stagnationCount).toBe(1)
    })
  })

  describe("#when injections keep failing past the cap and the reset window elapses", () => {
    test("#then the gate stops, then resumes after the reset window", async () => {
      const { enforcer, advance } = harness({ dispatch: async () => { throw new Error("boom") } })
      for (let index = 0; index < 6; index += 1) {
        advance(200_000)
        await enforcer.handleIdle(SESSION)
      }
      expect(enforcer.getState(SESSION).consecutiveFailures).toBe(5)

      expect(await enforcer.handleIdle(SESSION)).toEqual({ action: "skip", reason: "max consecutive failures" })

      advance(5 * 60 * 1000 + 1)
      const resumed = await enforcer.handleIdle(SESSION)
      expect(resumed.action).toBe("continue")
    })
  })

  describe("#when an abort error arrives", () => {
    test("#then the gate skips on the cancellation it records", async () => {
      const { enforcer } = harness()
      enforcer.onEvent({ type: "session.error", sessionID: SESSION, error: { name: "MessageAbortedError" } })

      expect(await enforcer.handleIdle(SESSION)).toEqual({ action: "skip", reason: "session was cancelled" })
      expect(enforcer.getState(SESSION).abortDetectedAt).toBe(1_000_000)
    })
  })

  describe("#when a token-limit error arrives", () => {
    test("#then the gate skips on the token-limit flag", async () => {
      const { enforcer } = harness()
      enforcer.onEvent({ type: "session.error", sessionID: SESSION, error: { message: "prompt is too long" } })

      expect(await enforcer.handleIdle(SESSION)).toEqual({ action: "skip", reason: "token limit detected" })
    })
  })

  describe("#when a compaction event arms the guard", () => {
    test("#then the gate skips until the guard is acknowledged", async () => {
      const { enforcer } = harness()
      enforcer.onEvent({ type: "session.compacted", sessionID: SESSION })

      expect(enforcer.isCompactionGuardActive(SESSION)).toBe(true)
      expect(await enforcer.handleIdle(SESSION)).toEqual({ action: "skip", reason: "compaction guard active" })
    })
  })

  describe("#when assistant activity is observed while idle", () => {
    test("#then the continuation response is recorded", async () => {
      const { enforcer } = harness()
      await enforcer.handleIdle(SESSION)

      enforcer.onEvent({ type: "message.part.delta", sessionID: SESSION, properties: { info: { role: "assistant" } } })

      expect(enforcer.getState(SESSION).continuationResponseObserved).toBe(true)
    })
  })

  describe("#when a countdown is configured", () => {
    test("#then the injection is deferred until the countdown fires", async () => {
      let scheduled
      const dispatches = []
      let resolveDispatched
      const dispatched = new Promise((resolve) => { resolveDispatched = resolve })
      const enforcer = createNativeTodoContinuationEnforcer({
        readTodos: async () => [todo()],
        getMessages: async () => ({ data: [assistantText()] }),
        resolveAgent: async () => "sisyphus",
        dispatch: async (input) => { dispatches.push(input); resolveDispatched() },
        countdownMs: 2000,
        schedule: (fn) => { scheduled = fn; return { unref() {} } },
      })

      await enforcer.handleIdle(SESSION)
      expect(dispatches).toHaveLength(0)
      expect(enforcer.getState(SESSION).inFlight).toBe(true)

      scheduled()
      await dispatched

      expect(dispatches).toHaveLength(1)
    })
  })
})
