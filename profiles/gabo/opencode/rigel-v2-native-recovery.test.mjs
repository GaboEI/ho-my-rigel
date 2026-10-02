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
