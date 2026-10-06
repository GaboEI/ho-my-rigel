/**
 * Exhaustive predicate tests for the V2 todo-continuation decision gate.
 *
 * Every branch of `decideTodoContinuation` is pinned: the positive continue
 * path, each of the 18 ordered skip conditions with its exact reason, the
 * numeric boundaries (abort window, failure cap, exponential cooldown,
 * stagnation cap), the first-match-wins ordering, and defensive defaults for an
 * empty snapshot. The gate constants are cross-checked against the V2 state
 * port and the V1 source so a drift between the three cannot pass silently.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  ABORT_WINDOW_MS,
  COMPACTION_GUARD_MS,
  CONTINUATION_COOLDOWN_MS,
  COUNTDOWN_SECONDS,
  DEFAULT_SKIP_AGENTS,
  FAILURE_RESET_WINDOW_MS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_STAGNATION_COUNT,
  decideTodoContinuation,
} from "./rigel-v2-native-todo-continuation-gate.mjs"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const V1_CONSTANTS = join(
  REPO_ROOT,
  "packages",
  "omo-opencode",
  "src",
  "hooks",
  "todo-continuation-enforcer",
  "constants.ts",
)

const NOW = 1_000_000

function baseSnapshot(overrides = {}) {
  return {
    sessionID: "ses_gate",
    state: {},
    todos: [{ id: "a", content: "task a", status: "pending", priority: "medium" }],
    incompleteCount: 1,
    hasBackgroundWork: false,
    hasPendingQuestion: false,
    isLastAssistantAborted: false,
    hasUnansweredQuestion: false,
    isCompactionGuardActive: false,
    skipAgents: DEFAULT_SKIP_AGENTS,
    resolvedAgent: "sisyphus",
    isContinuationStopped: false,
    hasProgressed: false,
    stagnationCount: 0,
    consecutiveFailures: 0,
    lastInjectedAt: undefined,
    now: NOW,
    ...overrides,
  }
}

/**
 * Parse a numeric V1 constant, tolerating the `5_000` separator style and
 * arithmetic expressions such as `5 * 60 * 1000`.
 */
function readV1NumberConstant(name) {
  const source = readFileSync(V1_CONSTANTS, "utf8")
  const match = new RegExp(`export const ${name}\\s*=\\s*([0-9_*+ \\t]+)`).exec(source)
  if (!match) throw new Error(`could not parse V1 constant ${name}`)
  const value = match[1]
    .split("+")
    .reduce((sum, term) => {
      const product = term
        .split("*")
        .reduce((acc, factor) => acc * Number(factor.replaceAll("_", "").trim()), 1)
      return sum + product
    }, 0)
  return Math.trunc(value)
}

describe("#given the V2 todo-continuation decision gate", () => {
  describe("#when every blocking condition is absent", () => {
    test("#then it continues with reason ok", () => {
      // given / when
      const decision = decideTodoContinuation(baseSnapshot())
      // then
      expect(decision).toEqual({ action: "continue", reason: "ok" })
    })

    test("#then an empty snapshot degrades to no todos instead of throwing", () => {
      // given / when
      const decision = decideTodoContinuation({})
      // then
      expect(decision).toEqual({ action: "skip", reason: "no todos" })
    })

    test("#then a call with no snapshot argument degrades to no todos", () => {
      // given / when
      const decision = decideTodoContinuation()
      // then
      expect(decision).toEqual({ action: "skip", reason: "no todos" })
    })
  })

  describe("#given gate 1 allTodosCompletedAt", () => {
    test("#then it skips with all todos completed", () => {
      // given
      const snapshot = baseSnapshot({ state: { allTodosCompletedAt: NOW - 1 } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "all todos completed",
      })
    })
  })

  describe("#given gate 2 isRecovering", () => {
    test("#then it skips with in recovery", () => {
      // given
      const snapshot = baseSnapshot({ state: { isRecovering: true } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "skip", reason: "in recovery" })
    })
  })

  describe("#given gate 3 wasCancelled", () => {
    test("#then it skips with session was cancelled", () => {
      // given
      const snapshot = baseSnapshot({ state: { wasCancelled: true } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "session was cancelled",
      })
    })
  })

  describe("#given gate 4 tokenLimitDetected", () => {
    test("#then it skips with token limit detected", () => {
      // given
      const snapshot = baseSnapshot({ state: { tokenLimitDetected: true } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "token limit detected",
      })
    })
  })

  describe("#given gate 5 unrecoverableErrorDetected", () => {
    test("#then it skips with unrecoverable error detected", () => {
      // given
      const snapshot = baseSnapshot({ state: { unrecoverableErrorDetected: true } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "unrecoverable error detected",
      })
    })
  })

  describe("#given gate 6 the abort window", () => {
    test("#then an abort inside ABORT_WINDOW_MS skips with abort detected", () => {
      // given
      const snapshot = baseSnapshot({ state: { abortDetectedAt: NOW - (ABORT_WINDOW_MS - 1) } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "abort detected",
      })
    })

    test("#then an abort exactly at the boundary is no longer blocking", () => {
      // given
      const snapshot = baseSnapshot({ state: { abortDetectedAt: NOW - ABORT_WINDOW_MS } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "continue", reason: "ok" })
    })

    test("#then a stale abort outside the window is no longer blocking", () => {
      // given
      const snapshot = baseSnapshot({ state: { abortDetectedAt: NOW - (ABORT_WINDOW_MS + 1) } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "continue", reason: "ok" })
    })

    test("#then the window is measured against the injected now, not a real clock", () => {
      // given
      const abortDetectedAt = NOW - 1000
      const inside = baseSnapshot({ state: { abortDetectedAt }, now: abortDetectedAt + 1000 })
      const outside = baseSnapshot({ state: { abortDetectedAt }, now: abortDetectedAt + ABORT_WINDOW_MS })
      // when / then
      expect(decideTodoContinuation(inside).reason).toBe("abort detected")
      expect(decideTodoContinuation(outside).reason).toBe("ok")
    })
  })

  describe("#given gate 7 hasBackgroundWork", () => {
    test("#then it skips with background work active", () => {
      // given
      const snapshot = baseSnapshot({ hasBackgroundWork: true })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "background work active",
      })
    })
  })

  describe("#given gate 8 pending questions", () => {
    test("#then a pending question skips with pending question", () => {
      // given
      const snapshot = baseSnapshot({ hasPendingQuestion: true })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "pending question",
      })
    })

    test("#then an unanswered question skips with pending question", () => {
      // given
      const snapshot = baseSnapshot({ hasUnansweredQuestion: true })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "pending question",
      })
    })
  })

  describe("#given gate 9 isLastAssistantAborted", () => {
    test("#then it skips with last assistant message aborted", () => {
      // given
      const snapshot = baseSnapshot({ isLastAssistantAborted: true })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "last assistant message aborted",
      })
    })
  })

  describe("#given gate 10 no todos", () => {
    test("#then an empty todo list skips with no todos", () => {
      // given
      const snapshot = baseSnapshot({ todos: [] })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "skip", reason: "no todos" })
    })

    test("#then an undefined todo list skips with no todos", () => {
      // given
      const snapshot = baseSnapshot({ todos: undefined })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "skip", reason: "no todos" })
    })

    test("#then a non-array todo list skips with no todos", () => {
      // given
      const snapshot = baseSnapshot({ todos: null })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "skip", reason: "no todos" })
    })
  })

  describe("#given gate 11 all todos complete", () => {
    test("#then a zero incomplete count skips with all todos complete", () => {
      // given
      const snapshot = baseSnapshot({
        todos: [
          { id: "a", content: "a", status: "completed", priority: "medium" },
          { id: "b", content: "b", status: "cancelled", priority: "medium" },
        ],
        incompleteCount: 0,
      })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "all todos complete",
      })
    })

    test("#then one remaining todo still continues", () => {
      // given
      const snapshot = baseSnapshot({ incompleteCount: 1 })
      // when / then
      expect(decideTodoContinuation(snapshot).action).toBe("continue")
    })
  })

  describe("#given gate 12 inFlight", () => {
    test("#then a scheduled injection skips with injection in flight", () => {
      // given
      const snapshot = baseSnapshot({ state: { inFlight: true } })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "injection in flight",
      })
    })
  })

  describe("#given gate 13 max consecutive failures", () => {
    test("#then the cap skips with max consecutive failures", () => {
      // given
      const snapshot = baseSnapshot({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "max consecutive failures",
      })
    })

    test("#then one below the cap is still eligible to continue", () => {
      // given
      const snapshot = baseSnapshot({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "continue", reason: "ok" })
    })

    test("#then the failure cap wins over the cooldown", () => {
      // given
      const snapshot = baseSnapshot({
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        lastInjectedAt: NOW - 1,
      })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("max consecutive failures")
    })
  })

  describe("#given gate 14 the exponential cooldown", () => {
    test("#then a recent injection skips with cooldown active", () => {
      // given
      const snapshot = baseSnapshot({ lastInjectedAt: NOW - (CONTINUATION_COOLDOWN_MS - 1) })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "cooldown active",
      })
    })

    test("#then the cooldown boundary is exclusive", () => {
      // given
      const snapshot = baseSnapshot({ lastInjectedAt: NOW - CONTINUATION_COOLDOWN_MS })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "continue", reason: "ok" })
    })

    test("#then each consecutive failure doubles the cooldown", () => {
      // given
      const cooldownAt4 = CONTINUATION_COOLDOWN_MS * 2 ** 4
      const justInside = baseSnapshot({ consecutiveFailures: 4, lastInjectedAt: NOW - (cooldownAt4 - 1) })
      const atBoundary = baseSnapshot({ consecutiveFailures: 4, lastInjectedAt: NOW - cooldownAt4 })
      // when / then
      expect(decideTodoContinuation(justInside).reason).toBe("cooldown active")
      expect(decideTodoContinuation(atBoundary).reason).toBe("ok")
    })

    test("#then a prior injection with no failures uses the base cooldown", () => {
      // given
      const justInside = baseSnapshot({ lastInjectedAt: NOW - (CONTINUATION_COOLDOWN_MS - 1) })
      const justOutside = baseSnapshot({ lastInjectedAt: NOW - CONTINUATION_COOLDOWN_MS })
      // when / then
      expect(decideTodoContinuation(justInside).reason).toBe("cooldown active")
      expect(decideTodoContinuation(justOutside).reason).toBe("ok")
    })

    test("#then no prior injection never triggers the cooldown", () => {
      // given
      const snapshot = baseSnapshot({ lastInjectedAt: undefined, now: NOW })
      // when / then
      expect(decideTodoContinuation(snapshot).action).toBe("continue")
    })
  })

  describe("#given gate 15 isCompactionGuardActive", () => {
    test("#then an armed guard skips with compaction guard active", () => {
      // given
      const snapshot = baseSnapshot({ isCompactionGuardActive: true })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "compaction guard active",
      })
    })

    test("#then the compaction guard is evaluated after the cooldown", () => {
      // given
      const snapshot = baseSnapshot({
        isCompactionGuardActive: true,
        lastInjectedAt: NOW - 1,
      })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("cooldown active")
    })

    test("#then the compaction guard is evaluated before the skip list", () => {
      // given
      const snapshot = baseSnapshot({
        isCompactionGuardActive: true,
        skipAgents: DEFAULT_SKIP_AGENTS,
        resolvedAgent: "prometheus",
      })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("compaction guard active")
    })
  })

  describe("#given gate 16 the agent skip list", () => {
    test("#then a default skip agent skips with agent in skip list", () => {
      // given
      const snapshot = baseSnapshot({ resolvedAgent: "prometheus" })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "agent in skip list",
      })
    })

    test("#then a custom skip agent skips with agent in skip list", () => {
      // given
      const snapshot = baseSnapshot({ skipAgents: ["oracle"], resolvedAgent: "oracle" })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "agent in skip list",
      })
    })

    test("#then a non-skipped agent continues", () => {
      // given
      const snapshot = baseSnapshot({ resolvedAgent: "sisyphus" })
      // when / then
      expect(decideTodoContinuation(snapshot).action).toBe("continue")
    })

    test("#then an unresolved agent is not matched against the skip list", () => {
      // given
      const snapshot = baseSnapshot({ skipAgents: ["prometheus"], resolvedAgent: undefined })
      // when / then
      expect(decideTodoContinuation(snapshot).action).toBe("continue")
    })

    test("#then an explicit empty skip list disables the gate", () => {
      // given
      const snapshot = baseSnapshot({ skipAgents: [], resolvedAgent: "prometheus" })
      // when / then
      expect(decideTodoContinuation(snapshot).action).toBe("continue")
    })

    test("#then a missing skip list falls back to the default skip agents", () => {
      // given
      const snapshot = baseSnapshot({ skipAgents: undefined, resolvedAgent: "plan" })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("agent in skip list")
    })

    test("#then the skip list is evaluated before the manual stop", () => {
      // given
      const snapshot = baseSnapshot({ resolvedAgent: "prometheus", isContinuationStopped: true })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("agent in skip list")
    })
  })

  describe("#given gate 17 isContinuationStopped", () => {
    test("#then a manual stop skips with continuation stopped", () => {
      // given
      const snapshot = baseSnapshot({ isContinuationStopped: true })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "continuation stopped",
      })
    })
  })

  describe("#given gate 18 the stagnation limit", () => {
    test("#then the cap skips with stagnation limit", () => {
      // given
      const snapshot = baseSnapshot({ stagnationCount: MAX_STAGNATION_COUNT })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({
        action: "skip",
        reason: "stagnation limit",
      })
    })

    test("#then one below the cap still continues", () => {
      // given
      const snapshot = baseSnapshot({ stagnationCount: MAX_STAGNATION_COUNT - 1 })
      // when / then
      expect(decideTodoContinuation(snapshot)).toEqual({ action: "continue", reason: "ok" })
    })

    test("#then the stagnation limit wins over progress being detected", () => {
      // given
      const snapshot = baseSnapshot({ stagnationCount: MAX_STAGNATION_COUNT, hasProgressed: true })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("stagnation limit")
    })
  })

  describe("#given overlapping blockers", () => {
    test("#then the earliest gate in the order wins", () => {
      // given
      const snapshot = baseSnapshot({
        state: { allTodosCompletedAt: NOW - 1, isRecovering: true, tokenLimitDetected: true },
        todos: [],
        incompleteCount: 0,
        hasBackgroundWork: true,
        stagnationCount: MAX_STAGNATION_COUNT,
      })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("all todos completed")
    })

    test("#then background work outranks pending questions", () => {
      // given
      const snapshot = baseSnapshot({ hasBackgroundWork: true, hasPendingQuestion: true })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("background work active")
    })

    test("#then no todos outranks the failure cap", () => {
      // given
      const snapshot = baseSnapshot({ todos: [], consecutiveFailures: MAX_CONSECUTIVE_FAILURES })
      // when / then
      expect(decideTodoContinuation(snapshot).reason).toBe("no todos")
    })
  })

  describe("#given the exported constants", () => {
    test("#then they equal the V1 todo-continuation constants", () => {
      // given / when / then
      expect(MAX_STAGNATION_COUNT).toBe(readV1NumberConstant("MAX_STAGNATION_COUNT"))
      expect(MAX_CONSECUTIVE_FAILURES).toBe(readV1NumberConstant("MAX_CONSECUTIVE_FAILURES"))
      expect(FAILURE_RESET_WINDOW_MS).toBe(readV1NumberConstant("FAILURE_RESET_WINDOW_MS"))
      expect(CONTINUATION_COOLDOWN_MS).toBe(readV1NumberConstant("CONTINUATION_COOLDOWN_MS"))
      expect(COMPACTION_GUARD_MS).toBe(readV1NumberConstant("COMPACTION_GUARD_MS"))
      expect(ABORT_WINDOW_MS).toBe(readV1NumberConstant("ABORT_WINDOW_MS"))
      expect(COUNTDOWN_SECONDS).toBe(readV1NumberConstant("COUNTDOWN_SECONDS"))
    })

    test("#then MAX_STAGNATION_COUNT is 3, MAX_CONSECUTIVE_FAILURES is 5, cooldown is 5s", () => {
      // given / when / then
      expect(MAX_STAGNATION_COUNT).toBe(3)
      expect(MAX_CONSECUTIVE_FAILURES).toBe(5)
      expect(CONTINUATION_COOLDOWN_MS).toBe(5000)
    })

    test("#then DEFAULT_SKIP_AGENTS is the V1 list", () => {
      // given / when / then
      expect(DEFAULT_SKIP_AGENTS).toEqual(["prometheus", "compaction", "plan"])
    })
  })
})
