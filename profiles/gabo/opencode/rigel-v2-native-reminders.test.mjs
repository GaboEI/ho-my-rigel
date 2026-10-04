import { describe, expect, test } from "bun:test"
import { createNativeToolResultReminders } from "./rigel-v2-native-reminders.mjs"

// Byte-exact V1 REMINDER_MESSAGE, pinned as a fixture the production runtime
// must reproduce when it decorates a search/fetch tool result.
const EXPECTED_AGENT_MESSAGE = `
[Agent Usage Reminder]

You called a search/fetch tool directly without leveraging specialized agents.

RECOMMENDED: Use task with explore/librarian agents for better results:

\`\`\`
// Parallel exploration - fire multiple agents simultaneously
task(subagent_type="explore", load_skills=[], prompt="Find all files matching pattern X")
task(subagent_type="explore", load_skills=[], prompt="Search for implementation of Y")
task(subagent_type="librarian", load_skills=[], prompt="Lookup documentation for Z")

// Then continue your work while they run in background
// System will notify you when each completes
\`\`\`

WHY:
- Agents can perform deeper, more thorough searches
- Background tasks run in parallel, saving time
- Specialized agents have domain expertise
- Reduces context window usage in main session

ALWAYS prefer: Multiple parallel task calls > Direct tool calls
`

function toolEvent({ tool, sessionID = "ses_1", agent = "Sisyphus - ultraworker", content = "tool output" } = {}) {
  return { status: "completed", tool, sessionID, agent, result: { content } }
}

// Real Map-backed storage implementing the injected V2 get/set contract.
function mapStorage() {
  const map = new Map()
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : undefined
    },
    async set(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      map.delete(key)
    },
    map,
  }
}

describe("Rigel native V2 agent-usage reminder", () => {
  test("appends the byte-exact reminder on the first three target tools and suppresses the fourth", async () => {
    // given
    const reminders = createNativeToolResultReminders()
    const contents = []

    // when
    for (let call = 0; call < 4; call += 1) {
      const event = toolEvent({ tool: "grep", sessionID: "ses-cap" })
      await reminders.after(event)
      contents.push(event.result.content)
    }

    // then
    expect(contents[0]).toBe(`tool output${EXPECTED_AGENT_MESSAGE}`)
    expect(contents[1]).toBe(`tool output${EXPECTED_AGENT_MESSAGE}`)
    expect(contents[2]).toBe(`tool output${EXPECTED_AGENT_MESSAGE}`)
    expect(contents[3]).toBe("tool output")
  })

  test("appends the reminder as a text block when the tool result content is an array", async () => {
    // given
    const reminders = createNativeToolResultReminders()
    const event = {
      status: "completed",
      tool: "glob",
      sessionID: "ses-array",
      agent: "atlas",
      result: { content: [] },
    }

    // when
    const appended = await reminders.after(event)

    // then
    expect(appended).toBe(true)
    expect(event.result.content).toHaveLength(1)
    expect(event.result.content[0]).toEqual({ type: "text", text: EXPECTED_AGENT_MESSAGE })
  })

  test("a delegation tool marks the session used and suppresses every later target reminder", async () => {
    for (const delegation of ["task", "call_omo_agent", "rigel_task"]) {
      // given
      const reminders = createNativeToolResultReminders()
      await reminders.after(toolEvent({ tool: delegation, sessionID: `ses-${delegation}` }))

      // when
      const later = toolEvent({ tool: "webfetch", sessionID: `ses-${delegation}` })
      await reminders.after(later)

      // then
      expect(later.result.content).not.toContain("[Agent Usage Reminder]")
    }
  })

  test("recognizes exactly the five orchestrator agents through config keys and display names", async () => {
    const orchestrators = [
      "sisyphus",
      "sisyphus-junior",
      "atlas",
      "hephaestus",
      "prometheus",
      "Sisyphus - ultraworker",
      "Sisyphus-Junior",
      "Atlas - Plan Executor",
      "Hephaestus - Deep Agent",
      "Prometheus - Plan Builder",
    ]
    for (const agent of orchestrators) {
      // given
      const reminders = createNativeToolResultReminders()
      const event = toolEvent({ tool: "grep", sessionID: `ses-orch-${agent}`, agent })

      // when
      await reminders.after(event)

      // then
      expect(event.result.content).toContain("[Agent Usage Reminder]")
    }
  })

  test("skips a known subagent and proceeds when the session agent is unknown", async () => {
    // given
    const skipping = createNativeToolResultReminders()
    const skipped = toolEvent({ tool: "grep", sessionID: "ses-explore", agent: "explore" })

    // when
    await skipping.after(skipped)

    // then
    expect(skipped.result.content).not.toContain("[Agent Usage Reminder]")

    // given
    const unknownAgent = createNativeToolResultReminders()
    const allowed = { status: "completed", tool: "grep", sessionID: "ses-unknown", result: { content: "out" } }

    // when
    await unknownAgent.after(allowed)

    // then
    expect(allowed.result.content).toContain("[Agent Usage Reminder]")
  })

  test("continues the reminder count across a restart through injected storage", async () => {
    // given
    const storage = mapStorage()
    const first = createNativeToolResultReminders({ storage })
    for (let call = 0; call < 3; call += 1) {
      await first.after(toolEvent({ tool: "grep", sessionID: "ses-restart" }))
    }
    first.clearAll()

    // when
    const second = createNativeToolResultReminders({ storage })
    const fourth = toolEvent({ tool: "grep", sessionID: "ses-restart" })
    await second.after(fourth)

    // then
    expect(fourth.result.content).not.toContain("[Agent Usage Reminder]")
  })

  test("persists a delegation so a restart never re-arms reminders", async () => {
    // given
    const storage = mapStorage()
    const first = createNativeToolResultReminders({ storage })
    await first.after(toolEvent({ tool: "task", sessionID: "ses-used-restart" }))
    first.clearAll()

    // when
    const second = createNativeToolResultReminders({ storage })
    const later = toolEvent({ tool: "grep", sessionID: "ses-used-restart" })
    await second.after(later)

    // then
    expect(later.result.content).not.toContain("[Agent Usage Reminder]")
  })

  test("session.deleted clears state and re-arms reminders", async () => {
    // given
    const storage = mapStorage()
    const reminders = createNativeToolResultReminders({ storage })
    for (let call = 0; call < 4; call += 1) {
      await reminders.after(toolEvent({ tool: "grep", sessionID: "ses-deleted" }))
    }

    // when
    await reminders.after({ type: "session.deleted", data: { sessionID: "ses-deleted" } })
    const rearmed = toolEvent({ tool: "grep", sessionID: "ses-deleted" })
    await reminders.after(rearmed)

    // then
    expect(rearmed.result.content).toContain("[Agent Usage Reminder]")
  })

  test("session.deleted resolves the id from a nested session object too", async () => {
    // given
    const reminders = createNativeToolResultReminders()
    for (let call = 0; call < 4; call += 1) {
      await reminders.after(toolEvent({ tool: "grep", sessionID: "ses-nested" }))
    }

    // when
    await reminders.after({ type: "session.deleted", data: { session: { id: "ses-nested" } } })
    const rearmed = toolEvent({ tool: "grep", sessionID: "ses-nested" })
    await reminders.after(rearmed)

    // then
    expect(rearmed.result.content).toContain("[Agent Usage Reminder]")
  })

  test("session.compacted does not reset the cap", async () => {
    // given
    const reminders = createNativeToolResultReminders()
    for (let call = 0; call < 3; call += 1) {
      await reminders.after(toolEvent({ tool: "grep", sessionID: "ses-compacted" }))
    }

    // when
    await reminders.after({ type: "session.compacted", properties: { sessionID: "ses-compacted" } })
    const fourth = toolEvent({ tool: "grep", sessionID: "ses-compacted" })
    await reminders.after(fourth)

    // then
    expect(fourth.result.content).not.toContain("[Agent Usage Reminder]")
  })

  test("degrades to in-memory only when no storage is injected", async () => {
    // given
    const reminders = createNativeToolResultReminders()
    const event = toolEvent({ tool: "grep", sessionID: "ses-memory" })

    // when
    const appended = await reminders.after(event)

    // then
    expect(appended).toBe(true)
    expect(event.result.content).toContain("[Agent Usage Reminder]")
  })

  test("keeps the ten non-task-tool threshold for the task tracking reminder", async () => {
    // given
    const reminders = createNativeToolResultReminders()
    for (let call = 0; call < 9; call += 1) {
      await reminders.after(toolEvent({ tool: "read", sessionID: "ses-task-reminder" }))
    }

    // when
    const tenth = toolEvent({ tool: "read", sessionID: "ses-task-reminder" })
    await reminders.after(tenth)

    // then
    expect(tenth.result.content).toContain("task tools have not been used recently")
  })
})
