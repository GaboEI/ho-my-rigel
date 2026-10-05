import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUlwExecuteCommand, substituteSessionContextPlaceholders } from "./rigel-v2-ulw-execute.mjs"

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rigel-ulw-execute-"))
  mkdirSync(join(directory, ".omo", "plans"), { recursive: true })
  writeFileSync(join(directory, ".omo", "plans", "wave.md"), "# Wave\n\n- [ ] Implement\n")
  const calls = { switch: [], prompt: [], clear: [] }
  const context = {
    session: {
      switchAgent: async (input) => calls.switch.push(input),
      prompt: async (input) => calls.prompt.push(input),
      context: async () => [],
    },
  }
  const command = createUlwExecuteCommand({ context, directory, registeredAgents: ["atlas"], stopContinuationState: { clear: (id) => calls.clear.push(id) }, now: () => new Date("2026-10-05T12:00:00.000Z") })
  return { directory, calls, command }
}

test("#given one plan #when ulw-execute starts #then it creates boulder state, notepads, switches Atlas, and injects once", async () => {
  const { directory, calls, command } = fixture()
  try {
    await command.execute({ sessionID: "ses_1", prompt: { text: "" } })
    const state = JSON.parse(readFileSync(join(directory, ".omo", "boulder.json"), "utf8"))
    expect(state.active_plan).toBe(join(directory, ".omo", "plans", "wave.md"))
    expect(state.session_ids).toEqual(["opencode:ses_1"])
    expect(readFileSync(join(directory, ".omo", "notepads", "wave", "learnings.md"), "utf8")).toContain("learnings")
    expect(calls.switch).toEqual([{ sessionID: "ses_1", agent: "atlas" }])
    expect(calls.clear).toEqual(["ses_1"])
    expect(calls.prompt).toHaveLength(1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("#given active boulder work #when a new session starts #then it resumes by appending that session", async () => {
  const { directory, command } = fixture()
  try {
    await command.execute({ sessionID: "ses_1", prompt: { text: "" } })
    await command.execute({ sessionID: "ses_2", prompt: { text: "" } })
    const state = JSON.parse(readFileSync(join(directory, ".omo", "boulder.json"), "utf8"))
    expect(state.session_ids).toEqual(["opencode:ses_1", "opencode:ses_2"])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("#given framework and user placeholders #when session context is rendered #then only framework placeholders are substituted", () => {
  const result = substituteSessionContextPlaceholders("You are starting an Atlas work session.\n<session-context>$SESSION_ID $TIMESTAMP</session-context> $SESSION_ID", "ses_1", "time")
  expect(result).toBe("You are starting an Atlas work session.\n<session-context>ses_1 time</session-context> $SESSION_ID")
})

test("#given an already injected session #when ulw-execute repeats #then it does not duplicate work or prompt", async () => {
  const { directory, calls, command } = fixture()
  try {
    command.execute = createUlwExecuteCommand({
      context: { session: { switchAgent: async () => {}, prompt: async (input) => calls.prompt.push(input), context: async () => [{ text: "<!-- omo-ulw-execute-context -->" }] } },
      directory,
      stopContinuationState: { clear() {} },
    }).execute
    await command.execute({ sessionID: "ses_1", prompt: { text: "" } })
    expect(calls.prompt).toHaveLength(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("#given a missing requested worktree #when ulw-execute starts #then injected context blocks worktree execution", async () => {
  const { directory, calls, command } = fixture()
  try {
    await command.execute({ sessionID: "ses_1", prompt: { text: "--worktree /missing-worktree" } })
    expect(calls.prompt[0].text).toContain("Worktree needs setup")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
