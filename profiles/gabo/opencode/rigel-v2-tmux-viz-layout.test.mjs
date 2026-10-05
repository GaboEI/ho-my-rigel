import { describe, expect, test } from "bun:test"
import {
  clampMainPaneSize, computeMainPaneWidth, computeCapacity, computeGridPlan,
  decideSpawnActions, buildSpawnArgs, buildApplyLayoutArgs, buildCloseArgs,
  MIN_SPLIT_WIDTH, MIN_SPLIT_HEIGHT,
} from "./rigel-v2-tmux-viz-layout.mjs"

function windowState(overrides = {}) {
  return {
    windowWidth: 200,
    windowHeight: 40,
    mainPane: { paneId: "%0", width: 140, height: 40, left: 0, top: 0, active: true, title: "" },
    agentPanes: [],
    ...overrides,
  }
}

describe("tmux-viz grid planning and spawn decisions", () => {
  test("clamps the main pane size to the V1 20-80 range", () => {
    expect(clampMainPaneSize(10)).toBe(20)
    expect(clampMainPaneSize(60)).toBe(60)
    expect(clampMainPaneSize(95)).toBe(80)
    expect(clampMainPaneSize(undefined)).toBe(50)
  })

  test("the main pane width respects the percentage and the configured minimums", () => {
    expect(computeMainPaneWidth({ windowWidth: 200, mainPaneSize: 50, mainPaneMinWidth: 40 })).toBe(100)
    expect(computeMainPaneWidth({ windowWidth: 200 })).toBe(159)
    expect(computeMainPaneWidth({ windowWidth: 100, mainPaneSize: 80, mainPaneMinWidth: 0, agentPaneMinWidth: 40 })).toBe(59)
  })

  test("the first agent pane splits the main pane; later panes follow the layout direction", () => {
    const first = decideSpawnActions({ windowState: windowState(), layout: "main-vertical" })
    expect(first.canSpawn).toBe(true)
    expect(first.actions).toEqual([{ kind: "spawn", direction: "-h", targetPaneId: "%0" }])
    const next = decideSpawnActions({
      windowState: windowState({ agentPanes: [{ paneId: "%1", width: 59, height: 40, left: 141, top: 0, active: false, title: "" }] }),
      layout: "main-vertical",
    })
    expect(next.actions).toEqual([{ kind: "spawn", direction: "-v", targetPaneId: "%1" }])
  })

  test("degraded decisions carry the exact V1 reasons", () => {
    const noMain = decideSpawnActions({ windowState: windowState({ mainPane: null }) })
    expect(noMain).toEqual({ canSpawn: false, reason: "no main pane found", actions: [] })
    const tooSmall = decideSpawnActions({ windowState: windowState({ windowWidth: MIN_SPLIT_WIDTH - 1 }) })
    expect(tooSmall.canSpawn).toBe(false)
    expect(tooSmall.reason).toContain("window too small for agent panes:")
    const tinyMain = decideSpawnActions({ windowState: windowState({ mainPane: { paneId: "%0", width: 20, height: 5, left: 0, top: 0, active: true, title: "" } }) })
    expect(tinyMain.reason).toBe("mainPane too small to split")
  })

  test("a full grid evicts exactly one pane to make room", () => {
    const agentPane = (index) => ({ paneId: `%${index}`, width: 40, height: 11, left: index * 41, top: 0, active: false, title: "" })
    const decision = decideSpawnActions({
      windowState: windowState({ agentPanes: [1, 2, 3, 4].map(agentPane) }),
      layout: "tiled",
    })
    expect(decision.canSpawn).toBe(true)
    expect(decision.reason).toBe("closed 1 pane to make room for split")
    expect(decision.actions[0].kind).toBe("close")
    expect(decision.actions[1].kind).toBe("spawn")
  })

  test("command builders reproduce the V1 argv shapes", () => {
    expect(buildSpawnArgs({ direction: "-h", targetPaneId: "%0", placeholderCommand: "sleep" })).toEqual([
      "split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%0", "sleep",
    ])
    expect(buildApplyLayoutArgs("main-vertical", 60)).toEqual([
      "select-layout", "main-vertical", ";", "set-window-option", "main-pane-width", "60%",
    ])
    expect(buildCloseArgs("%2")).toEqual([["send-keys", "-t", "%2", "C-c"], ["kill-pane", "-t", "%2"]])
  })
})
