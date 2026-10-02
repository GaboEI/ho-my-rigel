import { describe, expect, test } from "bun:test"
import { createNativeToolResultReminders } from "./rigel-v2-native-reminders.mjs"

function event({ tool, sessionID = "ses_1", agent = "Sisyphus - ultraworker", content = "tool output" }) {
  return { status: "completed", tool, sessionID, agent, result: { content } }
}

describe("Rigel native V2 tool-result reminders", () => {
  test("adds the agent-use reminder to the same result V1 decorated", () => {
    const reminders = createNativeToolResultReminders()
    const input = event({ tool: "grep" })
    reminders.after(input)
    expect(input.result.content).toContain("Agent Usage Reminder")
  })

  test("stops agent-use reminders once the native delegation tool is used", () => {
    const reminders = createNativeToolResultReminders()
    reminders.after(event({ tool: "rigel_task" }))
    const input = event({ tool: "glob" })
    reminders.after(input)
    expect(input.result.content).not.toContain("Agent Usage Reminder")
  })

  test("uses V1's ten non-task threshold for the task tracking reminder", () => {
    const reminders = createNativeToolResultReminders()
    for (let count = 0; count < 9; count += 1) reminders.after(event({ tool: "read" }))
    const tenth = event({ tool: "read" })
    reminders.after(tenth)
    expect(tenth.result.content).toContain("task tools have not been used recently")
  })
})
