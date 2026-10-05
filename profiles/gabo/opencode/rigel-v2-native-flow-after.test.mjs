/**
 * Hermetic tests for the native V2 `tool.execute.after` binders.
 *
 * Every behavior is exercised positive AND negative. The delegate-retry
 * detector/guidance port is compared against the REAL V1 cores
 * (`packages/delegate-core/src/retry-{patterns,guidance}.ts`) so upstream drift
 * fails the suite. The fsync cases use explicit numeric timestamps, so the
 * before/after watermark is deterministic and no wall clock is involved.
 */

import { describe, expect, test } from "bun:test"

import {
  afterRules,
  createDelegateTaskRetryRule,
  createFsyncSkipStartRule,
  createFsyncSkipWarningRule,
  createFsyncSkipWarningState,
  fsyncSkipBeforeRules,
} from "./rigel-v2-native-flow-after.mjs"
import {
  buildRetryGuidance as portedBuildRetryGuidance,
  detectDelegateTaskError as portedDetectDelegateTaskError,
} from "./rigel-v2-delegate-retry-core.mjs"
import { detectDelegateTaskError as v1DetectDelegateTaskError } from "../../../packages/delegate-core/src/retry-patterns.ts"
import { buildRetryGuidance as v1BuildRetryGuidance } from "../../../packages/delegate-core/src/retry-guidance.ts"
import { formatFsyncSkipWarning } from "./rigel-v2-flow-logic.mjs"

// ---------------------------------------------------------------------------
// 0. V1 differential parity for the ported detector + guidance
// ---------------------------------------------------------------------------

describe("#given the ported delegate-retry core", () => {
  describe("#when the detector runs over a V1 corpus", () => {
    test("#then it classifies identically to the real V1 core", () => {
      // given
      const corpus = [
        '[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low',
        '[ERROR] Unknown agent: "fake-agent". Available agents: explore, oracle',
        "[ERROR] Skills not found: nope. Available: git-master",
        "[ERROR] Invalid arguments: Provide EITHER category OR subagent_type, not both.",
        "Invalid arguments: Must provide either category or subagent_type.",
        "Invalid arguments: load_skills=null is not allowed. Pass [] if no skills needed.",
        "[ERROR] Agent name cannot be empty",
        "[ERROR] Cannot call primary agent \"x\"",
        "[ERROR] provider 500 from upstream",
        'Unknown category: "x". Available: quick',
        "all good, nothing to see",
      ]
      // when / then
      for (const output of corpus) {
        const ours = portedDetectDelegateTaskError(output)
        const v1 = v1DetectDelegateTaskError(output)
        expect(ours?.errorType ?? null).toBe(v1?.errorType ?? null)
      }
    })

    test("#then a non-string input degrades to null instead of throwing", () => {
      // given / when / then
      expect(portedDetectDelegateTaskError(undefined)).toBeNull()
      expect(portedDetectDelegateTaskError(null)).toBeNull()
    })
  })

  describe("#when guidance is built for every detected class", () => {
    test("#then the text is byte-identical to the real V1 core", () => {
      // given
      const corpus = [
        '[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low',
        '[ERROR] Unknown agent: "fake-agent". Available agents: explore, oracle',
        "[ERROR] Skills not found: nope. Available: git-master",
      ]
      // when / then
      for (const output of corpus) {
        const detected = v1DetectDelegateTaskError(output)
        expect(portedBuildRetryGuidance(detected)).toBe(v1BuildRetryGuidance(detected))
      }
    })

    test("#then an unknown errorType falls back to the same V1 string", () => {
      // given
      const unknown = { errorType: "not_a_known_type", originalOutput: "" }
      // when / then
      expect(portedBuildRetryGuidance(unknown)).toBe(v1BuildRetryGuidance(unknown))
    })
  })
})

// ---------------------------------------------------------------------------
// 1. delegate-task-retry: error channel only
// ---------------------------------------------------------------------------

function taskErrorEvent(errorText) {
  return { id: "call-1", tool: "rigel_task", status: "error", error: errorText, result: { content: [] } }
}

describe("#given the delegate-task-retry after rule", () => {
  describe("#when the error channel fires with a V1-detectable pattern", () => {
    test("#then the V1-specific guidance is appended to the mutable content", () => {
      // given
      const errorText = '[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low'
      const event = taskErrorEvent(errorText)
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      const expected = `\n${v1BuildRetryGuidance(v1DetectDelegateTaskError(errorText))}`
      expect(appended).toBe(true)
      expect(event.result.content).toHaveLength(1)
      expect(event.result.content[0].type).toBe("text")
      expect(event.result.content[0].text).toBe(expected)
      expect(event.result.content[0].text).toContain("[task CALL FAILED")
      expect(event.result.content[0].text).toContain("unknown_category")
    })

    test("#then the exported afterRules default wires the same behavior", () => {
      // given
      const event = taskErrorEvent("[ERROR] Unknown agent: \"ghost\". Available agents: explore")
      // when
      const appended = afterRules[0].run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).toContain("unknown_agent")
    })
  })

  describe("#when a success or background spawn completes", () => {
    test("#then nothing is appended for a completed tool call", () => {
      // given
      const event = { id: "call-2", tool: "rigel_task", status: "completed", result: { content: [{ type: "text", text: "done" }] } }
      // when
      const appended = afterRules[0].run(event)
      // then
      expect(appended).toBe(false)
      expect(event.result.content).toHaveLength(1)
    })

    test("#then nothing is appended for a background spawn receipt", () => {
      // given
      const event = {
        id: "call-3",
        tool: "rigel_task",
        status: "completed",
        result: { content: [{ type: "text", text: "The subagent is working in the background. sessionID: ses_x" }] },
      }
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(false)
      expect(event.result.content).toHaveLength(1)
    })
  })

  describe("#when the error channel fires without a V1 pattern match", () => {
    test("#then the generic announce/recover notice is appended, not specific guidance", () => {
      // given
      const event = taskErrorEvent("[ERROR] provider 500 from upstream")
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).toContain("Correct the call and retry")
      expect(event.result.content[0].text).not.toContain("[task CALL FAILED")
    })

    test("#then a coordinator rejection with no gate token also announces generically", () => {
      // given
      const event = taskErrorEvent('Cannot delegate to coordinator agent "prometheus" via task.')
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).toContain("Correct the call and retry")
    })

    test("#then a missing_run_in_background match is dropped to the generic notice", () => {
      // given
      const event = taskErrorEvent("[ERROR] run_in_background is required")
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).not.toContain("[task CALL FAILED")
    })
  })
})

// ---------------------------------------------------------------------------
// 2. fsync-skip-warning: before/after pairing on the stable call id
// ---------------------------------------------------------------------------

const SKIP = {
  filePath: "/Users/x/OneDrive/a",
  contextLabel: "atomicWrite:/Users/x/OneDrive/a",
  errorCode: "EPERM",
  message: "operation not permitted",
  pathClassification: "onedrive",
}

describe("#given the fsync-skip-warning before/after pair", () => {
  describe("#when a skip is recorded after the call start", () => {
    test("#then the exact V1 warning block is appended to the result", () => {
      // given
      const state = createFsyncSkipWarningState()
      const before = createFsyncSkipStartRule(state)
      const after = createFsyncSkipWarningRule(state)
      before.run({ id: "call-1", timestamp: 1000 })
      state.recordSkip({ ...SKIP, timestamp: 1001 })
      const event = { id: "call-1", timestamp: 1002, result: { content: [] } }
      // when
      const appended = after.run(event)
      // then
      const expected = `\n\n${formatFsyncSkipWarning([{ ...SKIP, timestamp: 1001 }])}`
      expect(appended).toBe(true)
      expect(event.result.content[0].text).toBe(expected)
      expect(event.result.content[0].text).toContain("[fsync-skipped]")
      expect(event.result.content[0].text).toContain("OneDrive")
    })
  })

  describe("#when no skip was recorded", () => {
    test("#then nothing is appended", () => {
      // given
      const state = createFsyncSkipWarningState()
      const before = createFsyncSkipStartRule(state)
      const after = createFsyncSkipWarningRule(state)
      before.run({ id: "call-2", timestamp: 2000 })
      const event = { id: "call-2", timestamp: 2001, result: { content: [] } }
      // when
      const appended = after.run(event)
      // then
      expect(appended).toBe(false)
      expect(event.result.content).toHaveLength(0)
    })
  })

  describe("#when the skip predates the call start", () => {
    test("#then the watermark excludes it and nothing is appended", () => {
      // given
      const state = createFsyncSkipWarningState()
      const before = createFsyncSkipStartRule(state)
      const after = createFsyncSkipWarningRule(state)
      before.run({ id: "call-3", timestamp: 3000 })
      state.recordSkip({ ...SKIP, timestamp: 2500 })
      const event = { id: "call-3", timestamp: 3001, result: { content: [] } }
      // when
      const appended = after.run(event)
      // then
      expect(appended).toBe(false)
      expect(event.result.content).toHaveLength(0)
    })
  })

  describe("#when the after event arrives without a recorded start", () => {
    test("#then no window exists and nothing is appended even with a pending skip", () => {
      // given
      const state = createFsyncSkipWarningState()
      const after = createFsyncSkipWarningRule(state)
      state.recordSkip({ ...SKIP, timestamp: 4000 })
      const event = { id: "call-4", timestamp: 4001, result: { content: [] } }
      // when
      const appended = after.run(event)
      // then
      expect(appended).toBe(false)
      expect(event.result.content).toHaveLength(0)
    })
  })

  describe("#when the same call id is drained twice", () => {
    test("#then the drained skip is consumed and never double-reported", () => {
      // given
      const state = createFsyncSkipWarningState()
      const before = createFsyncSkipStartRule(state)
      const after = createFsyncSkipWarningRule(state)
      before.run({ id: "call-5", timestamp: 5000 })
      state.recordSkip({ ...SKIP, timestamp: 5001 })
      const first = { id: "call-5", timestamp: 5002, result: { content: [] } }
      const second = { id: "call-5", timestamp: 5003, result: { content: [] } }
      // when
      const firstAppended = after.run(first)
      const secondAppended = after.run(second)
      // then
      expect(firstAppended).toBe(true)
      expect(secondAppended).toBe(false)
      expect(second.result.content).toHaveLength(0)
    })
  })

  describe("#when the exported before rules are inspected", () => {
    test("#then the fsync start recorder is present and named for the seam", () => {
      // given / when / then
      expect(Array.isArray(fsyncSkipBeforeRules)).toBe(true)
      expect(fsyncSkipBeforeRules).toHaveLength(1)
      expect(fsyncSkipBeforeRules[0].name).toBe("fsync-skip-warning:record-start")
      expect(typeof fsyncSkipBeforeRules[0].run).toBe("function")
    })
  })
})

// ---------------------------------------------------------------------------
// 3. read-image-resizer: NO-GO, explicitly not wired
// ---------------------------------------------------------------------------

describe("#given the read-image-resizer T10 NO-GO verdict", () => {
  describe("#when the after rule set is inspected", () => {
    test("#then no resizer rule, mock, or stub is present", () => {
      // given / when
      const names = afterRules.map((rule) => rule.name)
      const resizerNames = names.filter((name) => /resiz|image/i.test(name))
      // then
      expect(Array.isArray(afterRules)).toBe(true)
      expect(resizerNames).toEqual([])
      expect(names).toEqual(["delegate-task-retry", "fsync-skip-warning"])
    })
  })
})
