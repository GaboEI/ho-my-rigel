/**
 * Hermetic contracts for the todo-continuation QA seam.
 *
 * The seam exists so the live lab can drive the enforcer's failure/cooldown
 * path, which the V2 host cannot reject on its own. These tests pin the
 * default-off invariant (no control file -> the real dispatch runs untouched),
 * the rejection budget countdown, and the observed-state trace.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { createTodoContinuationQa, QA_CONTROL_FILE, QA_TRACE_FILE } from "./rigel-v2-native-todo-continuation-qa.mjs"

const roots = []

function stateRoot() {
  const dir = mkdtempSync(join(tmpdir(), "rigel-t22-qa-"))
  roots.push(dir)
  return dir
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true })
})

describe("#given a state root with no control file", () => {
  test("#when dispatch is wrapped and called, #then the real dispatch runs and nothing is traced", async () => {
    const root = stateRoot()
    const qa = createTodoContinuationQa({ stateRoot: root })
    const calls = []
    const dispatch = qa.wrapDispatch((input) => {
      calls.push(input)
      return Promise.resolve("real")
    })

    const result = await dispatch({ sessionID: "ses_x", text: "continue" })

    expect(result).toBe("real")
    expect(calls).toHaveLength(1)
    qa.observeAfterIdle({ sessionID: "ses_x", decision: { action: "continue", reason: "ok" }, state: { consecutiveFailures: 0 } })
    expect(() => readFileSync(join(root, "oh-my-rigel", QA_TRACE_FILE), "utf8")).toThrow()
  })
})

describe("#given an armed rejection budget", () => {
  test("#when dispatch is called past the budget, #then each armed call rejects and the rest reach the real dispatch", async () => {
    const root = stateRoot()
    const qa = createTodoContinuationQa({ stateRoot: root })
    qa.arm({ rejectInjections: 2, rejectReason: "qa-boom" })
    const calls = []
    const dispatch = qa.wrapDispatch((input) => {
      calls.push(input)
      return Promise.resolve("real")
    })

    await expect(dispatch({ sessionID: "ses_x", text: "continue" })).rejects.toThrow("qa-boom")
    await expect(dispatch({ sessionID: "ses_x", text: "continue" })).rejects.toThrow("qa-boom")
    await expect(dispatch({ sessionID: "ses_x", text: "continue" })).resolves.toBe("real")

    expect(calls).toHaveLength(1)
    const control = JSON.parse(readFileSync(join(root, "oh-my-rigel", QA_CONTROL_FILE), "utf8"))
    expect(control.rejectInjections).toBe(0)
  })
})

describe("#given observe is armed", () => {
  test("#when an idle observation is recorded, #then the trace carries the enforcer state", async () => {
    const root = stateRoot()
    const qa = createTodoContinuationQa({ stateRoot: root, now: () => 42 })
    qa.arm({ observe: true })
    qa.observeAfterIdle({
      sessionID: "ses_x",
      decision: { action: "continue", reason: "ok" },
      state: { consecutiveFailures: 3, inFlight: false, lastInjectedAt: 7, stagnationCount: 0, awaitingPostInjectionProgressCheck: true },
    })

    const lines = readFileSync(join(root, "oh-my-rigel", QA_TRACE_FILE), "utf8").trim().split("\n")
    const entry = JSON.parse(lines[0])
    expect(entry).toMatchObject({ at: 42, sessionID: "ses_x", consecutiveFailures: 3, inFlight: false, lastInjectedAt: 7 })
  })
})

describe("#given no state root is available", () => {
  test("#when the seam is created, #then it is disabled and dispatch passes through", async () => {
    const qa = createTodoContinuationQa({ stateRoot: undefined })
    const dispatch = qa.wrapDispatch(() => Promise.resolve("real"))

    expect(qa.enabled).toBe(false)
    qa.arm({ rejectInjections: 5 })
    await expect(dispatch({ sessionID: "ses_x", text: "continue" })).resolves.toBe("real")
  })
})
