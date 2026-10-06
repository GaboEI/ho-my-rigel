/**
 * RED parity tests for the V2 native todo-continuation state port.
 *
 * The port must reproduce the V1 per-session store surface and its progress
 * semantics: incomplete-count decrease and completed-count increase are
 * progress, content/priority-only changes are not (issue #4013), no-progress
 * after an injection observation increments stagnation, and progress resets it.
 * The V2 module does not exist yet, so every test here is RED until it lands.
 */

import { describe, expect, test } from "bun:test"

import { createNativeTodoContinuationState } from "./rigel-v2-native-todo-continuation-state.mjs"

const STORE_SURFACE = [
  "getState",
  "getExistingState",
  "trackContinuationProgress",
  "resetContinuationProgress",
  "cancelCountdown",
  "cleanup",
  "cancelAllCountdowns",
  "shutdown",
]

function trackedTodo(id, status, overrides = {}) {
  return { id, content: `todo ${id}`, status, priority: "medium", ...overrides }
}

describe("#given the V2 native todo-continuation state port", () => {
  describe("#when the store is created", () => {
    test("#then it exposes the V1 store surface", () => {
      // given / when
      const store = createNativeTodoContinuationState()
      // then
      for (const name of STORE_SURFACE) {
        expect(typeof store[name]).toBe("function")
      }
      store.shutdown()
    })

    test("#then getExistingState is undefined before first use and returns the tracked state after getState", () => {
      // given
      const store = createNativeTodoContinuationState()
      // when
      const before = store.getExistingState("ses_absent")
      const state = store.getState("ses_new")
      const after = store.getExistingState("ses_new")
      // then
      expect(before).toBeUndefined()
      expect(typeof state).toBe("object")
      expect(after).toBe(state)
      store.shutdown()
    })
  })

  describe("#given trackContinuationProgress", () => {
    test("#then hasProgressed is true when the incomplete count decreases", () => {
      // given
      const store = createNativeTodoContinuationState()
      const todos = [trackedTodo("a", "pending"), trackedTodo("b", "pending"), trackedTodo("c", "pending")]
      store.trackContinuationProgress("ses_dec", 3, todos)
      // when
      const update = store.trackContinuationProgress("ses_dec", 2, todos)
      // then
      expect(update.hasProgressed).toBe(true)
      store.shutdown()
    })

    test("#then hasProgressed is true when the completed count increases", () => {
      // given
      const store = createNativeTodoContinuationState()
      const before = [trackedTodo("a", "pending"), trackedTodo("b", "completed")]
      const after = [trackedTodo("a", "completed"), trackedTodo("b", "completed")]
      store.trackContinuationProgress("ses_done", 1, before)
      // when
      const update = store.trackContinuationProgress("ses_done", 1, after)
      // then
      expect(update.hasProgressed).toBe(true)
      store.shutdown()
    })

    test("#then hasProgressed is false when only content and priority change (issue #4013)", () => {
      // given
      const store = createNativeTodoContinuationState()
      const before = [trackedTodo("a", "pending", { content: "old", priority: "low" }), trackedTodo("b", "in_progress")]
      const after = [trackedTodo("a", "pending", { content: "new", priority: "high" }), trackedTodo("b", "in_progress")]
      store.trackContinuationProgress("ses_meta", 2, before)
      store.getState("ses_meta").awaitingPostInjectionProgressCheck = true
      // when
      const update = store.trackContinuationProgress("ses_meta", 2, after)
      // then
      expect(update.hasProgressed).toBe(false)
      store.shutdown()
    })
  })

  describe("#given stagnation tracking", () => {
    test("#then it increments when a post-injection check observes no progress", () => {
      // given
      const store = createNativeTodoContinuationState()
      const todos = [trackedTodo("a", "pending"), trackedTodo("b", "pending")]
      store.trackContinuationProgress("ses_stag", 2, todos)
      store.getState("ses_stag").awaitingPostInjectionProgressCheck = true
      // when
      const update = store.trackContinuationProgress("ses_stag", 2, todos)
      // then
      expect(update.hasProgressed).toBe(false)
      expect(update.stagnationCount).toBe(1)
      store.shutdown()
    })

    test("#then it resets when progress is observed", () => {
      // given
      const store = createNativeTodoContinuationState()
      const todos = [trackedTodo("a", "pending"), trackedTodo("b", "pending")]
      store.trackContinuationProgress("ses_reset", 2, todos)
      store.getState("ses_reset").awaitingPostInjectionProgressCheck = true
      store.trackContinuationProgress("ses_reset", 2, todos)
      // when
      store.getState("ses_reset").awaitingPostInjectionProgressCheck = true
      const update = store.trackContinuationProgress("ses_reset", 1, todos)
      // then
      expect(update.hasProgressed).toBe(true)
      expect(update.stagnationCount).toBe(0)
      store.shutdown()
    })
  })
})
