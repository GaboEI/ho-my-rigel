import { describe, expect, test } from "bun:test"
import {
  afterRules,
  beforeRules,
  createFlowRules,
  eventHandlers,
  requestSteps,
} from "./rigel-v2-native-flow-rules.mjs"
import { createFsyncSkipWarningState } from "./rigel-v2-native-flow-after.mjs"

const SKIP = {
  filePath: "notes.md",
  errorCode: "EPERM",
  pathClassification: "onedrive",
}

describe("#given the frozen flow-rule registry", () => {
  test("#then the before, after, and request chains keep their declared order", () => {
    // given / when / then
    expect(beforeRules.map((rule) => rule.name)).toEqual([
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "fsync-skip-warning:record-start",
    ])
    expect(afterRules.map((rule) => rule.name)).toEqual(["delegate-task-retry", "fsync-skip-warning"])
    expect(requestSteps.map((step) => step.name)).toEqual(["tool-pair-validator", "stop-continuation-guard", "image-resizer"])
    expect(Object.isFrozen(beforeRules)).toBe(true)
    expect(Object.isFrozen(afterRules)).toBe(true)
    expect(Object.isFrozen(requestSteps)).toBe(true)
    expect(Object.isFrozen(eventHandlers)).toBe(true)
    expect(eventHandlers).toHaveLength(0)
  })
})

describe("#given a factory-built flow set with an injected fsync tracker", () => {
  test("#when the before start rule records a call #then the after rule drains through the injected tracker", async () => {
    // given
    const fsyncSkipState = createFsyncSkipWarningState()
    const rules = createFlowRules({ fsyncSkipState })
    const startRule = rules.beforeRules.find((rule) => rule.name === "fsync-skip-warning:record-start")
    const warningRule = rules.afterRules.find((rule) => rule.name === "fsync-skip-warning")
    const result = { content: [] }
    // when
    await startRule.run({ id: "call_flow", timestamp: 1000 })
    fsyncSkipState.recordSkip({ ...SKIP, timestamp: 1001 })
    await warningRule.run({ id: "call_flow", timestamp: 1002, result })
    // then
    expect(result.content).toHaveLength(1)
    expect(result.content[0].text).toContain("[fsync-skipped]")
  })

  test("#when two factory instances run #then their trackers stay isolated", async () => {
    // given
    const first = createFlowRules()
    const second = createFlowRules()
    const startRule = first.beforeRules.find((rule) => rule.name === "fsync-skip-warning:record-start")
    const warningRule = second.afterRules.find((rule) => rule.name === "fsync-skip-warning")
    const result = { content: [] }
    // when
    await startRule.run({ id: "call_isolated", timestamp: 1000 })
    await warningRule.run({ id: "call_isolated", timestamp: 1001, result })
    // then
    expect(result.content).toEqual([])
  })
})
