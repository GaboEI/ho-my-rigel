import { describe, expect, test } from "bun:test"
import { parsePaneStateOutput, selectMainPane, queryWindowState, PANE_STATE_FORMAT } from "./rigel-v2-tmux-viz-pane-state.mjs"

const SAMPLE = [
  "%0\t180\t40\t0\t0\t1\t200\t40\t1\t1\t",
  "%1\t19\t40\t181\t0\t0\t200\t40\t1\t1\tomo-subagent-scout",
  "%2\t19\t40\t200\t0\t0\t200\t40\t1\t1\tomo-subagent-digger",
].join("\n")

describe("tmux-viz pane state", () => {
  test("the query format matches the eleven V1 fields", () => {
    expect(PANE_STATE_FORMAT.split("\t")).toHaveLength(11)
    expect(PANE_STATE_FORMAT).toContain("#{session_attached}")
  })

  test("parses geometry, active flags, attachment and titles", () => {
    const parsed = parsePaneStateOutput(SAMPLE)
    expect(parsed.panes).toHaveLength(3)
    expect(parsed.panes[1]).toEqual({ paneId: "%1", width: 19, height: 40, left: 181, top: 0, active: false, title: "omo-subagent-scout" })
    expect(parsed.windowWidth).toBe(200)
    expect(parsed.windowHeight).toBe(40)
    expect(parsed.windowActive).toBe(true)
    expect(parsed.sessionAttached).toBe(true)
  })

  test("the main pane is the leftmost, then widest, then topmost", () => {
    const parsed = parsePaneStateOutput(SAMPLE)
    const { mainPane, agentPanes } = selectMainPane(parsed.panes, "%1")
    expect(mainPane.paneId).toBe("%0")
    expect(agentPanes.map((pane) => pane.paneId)).toEqual(["%1", "%2"])
  })

  test("a failed query or a window without a main pane degrades to null", async () => {
    const failingRunner = { run: async () => ({ exitCode: 1, stdout: "", stderr: "error" }) }
    expect(await queryWindowState({ runner: failingRunner, sourcePaneId: "%0" })).toBeNull()
    const emptyRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }
    expect(await queryWindowState({ runner: emptyRunner, sourcePaneId: "%0" })).toBeNull()
  })

  test("a successful query returns the window state used by spawn decisions", async () => {
    const runner = { run: async (args) => ({ exitCode: 0, stdout: SAMPLE, stderr: "", args }) }
    const state = await queryWindowState({ runner, sourcePaneId: "%0" })
    expect(state.mainPane.paneId).toBe("%0")
    expect(state.agentPanes).toHaveLength(2)
  })
})
