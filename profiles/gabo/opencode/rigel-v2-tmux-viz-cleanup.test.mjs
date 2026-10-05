import { describe, expect, test } from "bun:test"
import {
  closeTmuxPane, isPaneGoneError, parseStaleSessions, parseStalePanes,
  sweepStaleTmuxResources, MAX_CLOSE_RETRY_COUNT,
} from "./rigel-v2-tmux-viz-cleanup.mjs"
import { createTmuxVizRunner } from "./rigel-v2-tmux-viz-runner.mjs"

function scriptedRunner(script) {
  return createTmuxVizRunner({ tmuxPath: "/fake/tmux", spawnImpl: (args) => {
    const key = args.join(" ")
    const [exitCode, stdout, stderr] = script(key) ?? [0, "", ""]
    return { exitCode: Promise.resolve(exitCode), stdout: Promise.resolve(stdout), stderr: Promise.resolve(stderr) }
  } })
}

describe("tmux-viz cleanup", () => {
  test("closing a pane interrupts it, then kills it", async () => {
    const calls = []
    const runner = scriptedRunner((key) => { calls.push(key); return key.includes("kill-pane") ? [0, "", ""] : [0, "", ""] })
    const result = await closeTmuxPane({ runner, paneId: "%5", sleep: async () => {} })
    expect(result.closed).toBe(true)
    expect(calls[0]).toContain("send-keys -t %5 C-c")
    expect(calls[1]).toContain("kill-pane -t %5")
  })

  test("a pane that is already gone is treated as success, not a failure", async () => {
    expect(isPaneGoneError("can't find pane: %5")).toBe(true)
    const runner = scriptedRunner((key) => key.includes("kill-pane") ? [1, "", "can't find pane: %5"] : [0, "", ""])
    const result = await closeTmuxPane({ runner, paneId: "%5", sleep: async () => {} })
    expect(result.closed).toBe(true)
    const hardFailure = scriptedRunner((key) => key.includes("kill-pane") ? [1, "", "server exited abruptly"] : [0, "", ""])
    const failed = await closeTmuxPane({ runner: hardFailure, paneId: "%5", sleep: async () => {} })
    expect(failed.closed).toBe(false)
    expect(failed.reason).toContain("kill-pane failed")
  })

  test("the zombie sweep kills omo-agents sessions of dead pids and orphan omo panes", async () => {
    const runner = scriptedRunner((key) => {
      if (key.includes("list-sessions")) return [0, "omo-agents-111\nomo-agents-999\nmain-session", ""]
      if (key.includes("list-panes -a")) return [0, "%9\tomo-subagent-scout\thttp://127.0.0.1:1\tsleep 86400\n%7\tomo-team-x\thttp://127.0.0.1:1\topencode attach", ""]
      return [0, "", ""]
    })
    const killed = await sweepStaleTmuxResources({ runner, managerPid: 999, isServerAlive: () => false })
    expect(killed.sessions).toEqual(["omo-agents-111"])
    expect(killed.panes).toEqual(["%9"])
  })

  test("close retry bounds are the V1 constants", () => {
    expect(MAX_CLOSE_RETRY_COUNT).toBe(3)
  })
})
