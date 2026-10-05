import { describe, expect, test } from "bun:test"
import { createTmuxVizManager } from "./rigel-v2-tmux-viz-manager.mjs"

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
