import { describe, expect, test } from "bun:test"
import { createTmuxVizManager } from "./rigel-v2-tmux-viz-manager.mjs"
import { MAX_CLOSE_RETRY_COUNT, CLOSE_RETRY_COOLDOWN_MS } from "./rigel-v2-tmux-viz-cleanup.mjs"

function memoryEnv({ withTmux = true } = {}) {
  return withTmux
    ? { PATH: process.env.PATH, TMUX: "/tmp/tmux-qa", TMUX_PANE: "%0" }
    : { PATH: process.env.PATH }
}

function managerOverrides({ spawnScript, withTmux = true, isolation = "inline", serverAlive = true } = {}) {
  const healthMarker = {}
  const spawnCalls = []
  return {
    config: { layout: "main-vertical", isolation },
    env: memoryEnv({ withTmux }),
    serverUrl: serverAlive ? "http://127.0.0.1:1" : undefined,
    directory: "/work",
    fetchSessionStatus: async () => new Map([["ses_child", "running"]]),
    spawnImpl: (args) => {
      spawnCalls.push(args.join(" "))
      if (args[0] === "list-panes") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%0\t200\t40\t0\t0\t1\t200\t40\t1\t1\t\n"), stderr: Promise.resolve("") }
      if (args[0] === "split-window") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%9\n"), stderr: Promise.resolve("") }
      return { exitCode: Promise.resolve(0), stdout: Promise.resolve(""), stderr: Promise.resolve("") }
    },
    sleep: async () => {},
    healthMarker,
    spawnCalls,
  }
}

const CHILD_EVENT = { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent", title: "scout" } } }

describe("tmux-viz manager", () => {
  test("with tmux available it splits the source pane, tracks the session and titles the pane", async () => {
    const overrides = managerOverrides()
    const manager = createTmuxVizManager(overrides)
    expect(manager.enabled).toBe(true)
    // when
    await manager.onSessionCreated(CHILD_EVENT)
    // then
    expect(overrides.spawnCalls.some((call) => call.includes("split-window"))).toBe(true)
    expect(overrides.spawnCalls.some((call) => call.includes("select-pane -t %9 -T omo-subagent-"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    await manager.cleanup()
  })

  test("top-level sessions, duplicates and team members never spawn a pane", async () => {
    const overrides = managerOverrides()
    const manager = createTmuxVizManager({ ...overrides, shouldSkipSession: (id) => id === "ses_member" })
    await manager.onSessionCreated({ type: "session.created", properties: { info: { id: "ses_top", title: "lead" } } })
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionCreated({ type: "session.created", properties: { info: { id: "ses_member", parentID: "p", title: "m" } } })
    expect(overrides.spawnCalls.some((call) => call.includes("split-window"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_member")).toBeNull()
    expect(overrides.spawnCalls.filter((call) => call.includes("split-window"))).toHaveLength(1)
    await manager.cleanup()
  })

  test("without tmux the manager degrades explicitly and never runs tmux", async () => {
    const overrides = managerOverrides({ withTmux: false })
    const manager = createTmuxVizManager(overrides)
    expect(manager.enabled).toBe(false)
    expect(manager.degradedReason).toBe("not inside a tmux or cmux environment")
    await manager.onSessionCreated(CHILD_EVENT)
    expect(overrides.spawnCalls).toEqual([])
    await manager.cleanup()
  })

  test("session.deleted closes the tracked pane with C-c then kill-pane", async () => {
    const overrides = managerOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    expect(overrides.spawnCalls.some((call) => call.includes("send-keys -t %9 C-c"))).toBe(true)
    expect(overrides.spawnCalls.some((call) => call.includes("kill-pane -t %9"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_child")).toBeNull()
  })

  test("an unreachable opencode server defers the spawn instead of failing silently", async () => {
    const overrides = managerOverrides({ serverAlive: false })
    overrides.spawnImpl = (args) => {
      if (args[0] === "list-panes") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%0\t200\t40\t0\t0\t1\t200\t40\t1\t1\t\n"), stderr: Promise.resolve("") }
      return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%9\n"), stderr: Promise.resolve("") }
    }
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    expect(overrides.spawnCalls.some((call) => call.includes("split-window"))).toBe(false)
    expect(manager.getTrackedPaneId("ses_child")).toBeNull()
    await manager.cleanup()
  })
})

describe("tmux-viz manager pending close retry and cooldown", () => {
  function retryOverrides() {
    const logs = []
    const spawnCalls = []
    const state = { failKill: true }
    const overrides = {
      config: { layout: "main-vertical", isolation: "inline" },
      env: memoryEnv({ withTmux: true }),
      serverUrl: "http://127.0.0.1:1",
      directory: "/work",
      fetchSessionStatus: async () => new Map([["ses_child", "running"]]),
      spawnImpl: (args) => {
        spawnCalls.push(args.join(" "))
        if (args[0] === "list-panes") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%0\t200\t40\t0\t0\t1\t200\t40\t1\t1\t\n"), stderr: Promise.resolve("") }
        if (args[0] === "split-window") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%9\n"), stderr: Promise.resolve("") }
        if (args[0] === "kill-pane") {
          return state.failKill
            ? { exitCode: Promise.resolve(1), stdout: Promise.resolve(""), stderr: Promise.resolve("server exited abruptly") }
            : { exitCode: Promise.resolve(0), stdout: Promise.resolve(""), stderr: Promise.resolve("") }
        }
        return { exitCode: Promise.resolve(0), stdout: Promise.resolve(""), stderr: Promise.resolve("") }
      },
      sleep: async () => {},
      healthMarker: {},
      logger: (line) => logs.push(line),
    }
    const killCount = () => spawnCalls.filter((call) => call.startsWith("kill-pane")).length
    return { overrides, state, logs, killCount }
  }

  test("a failed delete close stays pending and a later retry removes the tracked pane", async () => {
    // given: a session whose pane close fails on deletion
    const { overrides, state, logs } = retryOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    // when
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    // then: still tracked, marked pending
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    expect(logs.some((line) => line.includes("pending retry"))).toBe(true)
    // when: the pane becomes closable and a retry pass runs
    state.failKill = false
    await manager.retryPendingCloses(Date.now())
    // then
    expect(manager.getTrackedPaneId("ses_child")).toBeNull()
    expect(logs.some((line) => line.includes("retried close succeeded"))).toBe(true)
    await manager.cleanup()
  })

  test("repeated retry failures arm the cooldown and keep the session tracked", async () => {
    // given
    const { overrides, logs } = retryOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    const base = 1_000_000
    // when: MAX_CLOSE_RETRY_COUNT retry passes all fail
    for (let index = 0; index < MAX_CLOSE_RETRY_COUNT; index += 1) {
      await manager.retryPendingCloses(base + index * 1000)
    }
    // then: the pane is still tracked and the cooldown was armed
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    expect(logs.some((line) => line.includes(`cooldown ${CLOSE_RETRY_COOLDOWN_MS / 60000}min armed`))).toBe(true)
    await manager.cleanup()
  })

  test("the cooldown blocks retries until it elapses and then resets the retry state", async () => {
    // given: a session whose retries exhausted and armed the cooldown
    const { overrides, logs, killCount } = retryOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    const base = 2_000_000
    for (let index = 0; index < MAX_CLOSE_RETRY_COUNT; index += 1) {
      await manager.retryPendingCloses(base + index * 1000)
    }
    const armingPass = base + (MAX_CLOSE_RETRY_COUNT - 1) * 1000
    const cooldownUntil = armingPass + CLOSE_RETRY_COOLDOWN_MS
    const afterArming = killCount()
    // when: a pass runs before the cooldown elapses
    await manager.retryPendingCloses(cooldownUntil - 1)
    // then: no further close attempt
    expect(killCount()).toBe(afterArming)
    // when: the cooldown elapses
    await manager.retryPendingCloses(cooldownUntil)
    // then: the reset is logged, the session stays tracked but unwedged
    expect(logs.some((line) => line.includes("cooldown elapsed"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    await manager.cleanup()
  })
})
