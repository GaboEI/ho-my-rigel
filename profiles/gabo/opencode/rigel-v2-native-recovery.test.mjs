import { describe, expect, test } from "bun:test"
import { applyNativeRecoveryReminder } from "./rigel-v2-native-recovery.mjs"

function event(tool, content) {
  return { status: "completed", tool, result: { content } }
}

describe("Rigel native V2 recovery hints", () => {
  test("adds the V1 edit recovery instruction to a matching edit failure", () => {
    const input = event("edit", "Error: oldString not found in file")
    expect(applyNativeRecoveryReminder(input)).toBe(true)
    expect(input.result.content).toContain("[EDIT ERROR - IMMEDIATE ACTION REQUIRED]")
  })

  test("adds the JSON recovery instruction only for non-excluded tools", () => {
    const input = event("custom_tool", "Invalid JSON: expected '}'")
    expect(applyNativeRecoveryReminder(input)).toBe(true)
    expect(input.result.content).toContain("[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]")
    const excluded = event("grep", "Invalid JSON: expected '}'")
    expect(applyNativeRecoveryReminder(excluded)).toBe(false)
  })

  test("does not duplicate the JSON recovery instruction", () => {
    const input = event("custom_tool", "Invalid JSON")
    applyNativeRecoveryReminder(input)
    expect(applyNativeRecoveryReminder(input)).toBe(false)
  })
})

describe("Rigel native V2 recovery on real failed-tool shapes", () => {
  test("#given a failed edit reported on the error field #when recovery runs #then it appends to the error channel", () => {
    const input = { status: "error", tool: "edit", sessionID: "ses", error: "Error: oldString not found in file" }
    expect(applyNativeRecoveryReminder(input)).toBe(true)
    expect(input.error).toContain("[EDIT ERROR - IMMEDIATE ACTION REQUIRED]")
  })

  test("#given the real V2 edit failure phrasing #when recovery runs #then it appends the edit reminder", () => {
    const input = { status: "error", tool: "edit", sessionID: "ses", result: { error: { type: "tool.execution", message: "Could not find oldString in target.txt. It must match exactly, including whitespace and indentation." } } }
    expect(applyNativeRecoveryReminder(input)).toBe(true)
    expect(input.result.content).toContain("[EDIT ERROR - IMMEDIATE ACTION REQUIRED]")
  })

  test("#given the exact live V2 event (error object, no result) #when recovery runs #then it appends to error.message", () => {
    const input = { tool: "edit", status: "error", sessionID: "ses", agent: "x", id: "toolu_1", messageID: "msg_1", input: { path: "target.txt" }, error: { _tag: "Tool.Error", message: "Could not find oldString in target.txt. It must match exactly, including whitespace and indentation." } }
    expect(applyNativeRecoveryReminder(input)).toBe(true)
    expect(input.error.message).toContain("[EDIT ERROR - IMMEDIATE ACTION REQUIRED]")
  })

  test("#given a failed edit carrying result.error #when recovery runs #then it appends to result content", () => {
    const input = { status: "error", tool: "edit", result: { error: "oldString found multiple times" } }
    expect(applyNativeRecoveryReminder(input)).toBe(true)
    expect(input.result.error).toContain("[EDIT ERROR - IMMEDIATE ACTION REQUIRED]")
  })

  test("#given a real JSON parse failure on a non-excluded tool #when recovery runs #then it appends the JSON hint", () => {
    const input = { status: "error", tool: "write", result: { content: "Invalid JSON: expected '}'" } }
    expect(applyNativeRecoveryReminder(input)).toBe(true)
    expect(input.result.content).toContain("[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]")
  })

  test("#given an excluded tool #when recovery runs #then nothing is appended", () => {
    const input = { status: "error", tool: "shell", error: "invalid json in arguments" }
    expect(applyNativeRecoveryReminder(input)).toBe(false)
  })
})
