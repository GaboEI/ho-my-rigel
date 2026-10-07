import { describe, expect, test } from "bun:test"
import { createNativeTeamEventHandlers } from "./rigel-v2-team-events.mjs"
import { createTeamTools, TEAM_TOOL_NAMES } from "./tools/team.tools.mjs"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan({ prefix = "" } = {}) {
      return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  }
}

function recordingSession() {
  const prompts = []
  return {
    prompts,
    session: {
      prompt: async (input) => { prompts.push(input); return { data: {} } },
    },
  }
}

async function seedTeam(storage, overrides = {}) {
  const tools = createTeamTools({ storage, getSessionID: () => "lead-session" })
  await tools.team_create.execute({
    team_name: "builders",
    members: [
      { name: "scout", sessionID: "member-scout" },
      { name: "digger", sessionID: "member-digger" },
    ],
  })
  await tools.team_send_message.execute({ team_name: "builders", message: "please start", to: "scout" })
  for (const [key, value] of Object.entries(overrides)) {
    await storage.set(key, value)
  }
  return tools
}

const idleScout = () => ({ type: "session.idle", sessionID: "member-scout" })

describe("native team event handlers", () => {
  test("the handler set exposes exactly the four team behaviors", () => {
    const handlers = createNativeTeamEventHandlers({ storage: memoryStorage(), session: {} })
    expect(handlers).toHaveLength(4)
    for (const handler of handlers) expect(typeof handler).toBe("function")
  })

  test("team_create normalizes members and team_send_message routes unread messages", async () => {
    // given
    const storage = memoryStorage()
    const tools = await seedTeam(storage)
    // when
    const team = await tools.team_status.execute({ team_name: "builders" })
    // then
    expect(team.leaderSessionID).toBe("lead-session")
    expect(team.members.map((member) => [member.name, member.sessionID, member.status])).toEqual([
      ["scout", "member-scout", "running"],
      ["digger", "member-digger", "running"],
    ])
    expect(team.messages).toHaveLength(1)
    expect(team.messages[0]).toMatchObject({ to: "scout", text: "please start", read: false })
    expect(typeof team.messages[0].id).toBe("string")
  })

  test("team_send_message rejects routing to a member outside the team", async () => {
    const storage = memoryStorage()
    const tools = await seedTeam(storage)
    await expect(tools.team_send_message.execute({ team_name: "builders", message: "hi", to: "ghost" })).rejects.toThrow("ghost")
  })

  test("an idle member with unread messages is woken once and the messages are acked", async () => {
    // given
    const storage = memoryStorage()
    const tools = await seedTeam(storage)
    const { session, prompts } = recordingSession()
    const handlers = createNativeTeamEventHandlers({ storage, session })
    // when
    await handlers[0](idleScout())
    // then
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionID: "member-scout", delivery: "queue" })
    expect(prompts[0].text).toContain("1 new team message")
    const team = await tools.team_status.execute({ team_name: "builders" })
    expect(team.messages.every((message) => message.read === true)).toBe(true)
    // when: a second idle inside the suppression window does not re-wake
    await handlers[0](idleScout())
    expect(prompts).toHaveLength(1)
  })

  test("an idle member without unread messages is never woken", async () => {
    const storage = memoryStorage()
    const { session, prompts } = recordingSession()
    const handlers = createNativeTeamEventHandlers({ storage, session })
    await handlers[0](idleScout())
    expect(prompts).toHaveLength(0)
  })

  test("member sessions transition running -> idle -> completed across the event types", async () => {
    // given
    const storage = memoryStorage()
    const tools = await seedTeam(storage)
    const handlers = createNativeTeamEventHandlers({ storage, session: {} })
    // when
    await handlers[1]({ type: "session.idle", sessionID: "member-digger" })
    let team = await tools.team_status.execute({ team_name: "builders" })
    // then
    expect(team.members.find((member) => member.name === "digger").status).toBe("idle")
    await handlers[1]({ type: "session.deleted", sessionID: "member-digger" })
    team = await tools.team_status.execute({ team_name: "builders" })
    expect(team.members.find((member) => member.name === "digger").status).toBe("completed")
  })

  test("a member session error marks the member errored with the recorded error text", async () => {
    // given
    const storage = memoryStorage()
    const tools = await seedTeam(storage)
    const handlers = createNativeTeamEventHandlers({ storage, session: {} })
    // when
    await handlers[2]({ type: "session.error", sessionID: "member-scout", data: { error: "provider down" } })
    // then
    const team = await tools.team_status.execute({ team_name: "builders" })
    expect(team.members.find((member) => member.name === "scout")).toMatchObject({ status: "errored", error: "provider down" })
  })

  test("deleting the leader session marks the team orphaned exactly once", async () => {
    // given
    const storage = memoryStorage()
    const tools = await seedTeam(storage)
    const handlers = createNativeTeamEventHandlers({ storage, session: {} })
    // when
    await handlers[3]({ type: "session.deleted", sessionID: "lead-session" })
    let team = await tools.team_status.execute({ team_name: "builders" })
    // then
    expect(team.status).toBe("orphaned")
    await handlers[3]({ type: "session.deleted", sessionID: "lead-session" })
    team = await tools.team_status.execute({ team_name: "builders" })
    expect(team.status).toBe("orphaned")
  })

  test("a throwing handler is logged and never propagates into the shared event loop", async () => {
    // given: a storage whose scan rejects, so the idle-wake-hint body throws for real
    const logs = []
    const throwingStorage = {
      get: async () => undefined,
      set: async () => {},
      scan: async () => { throw new Error("scan boom") },
    }
    const handlers = createNativeTeamEventHandlers({ storage: throwingStorage, session: {}, log: (line) => logs.push(line) })
    // when: a session.idle event drives idle-wake-hint into the rejecting scan
    let propagated = null
    try {
      await handlers[0]({ type: "session.idle", sessionID: "member-scout" })
    } catch (error) {
      propagated = error
    }
    // then: the throw was isolated and logged with the handler name and message, and never rethrown
    expect(propagated).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("idle-wake-hint")
    expect(logs[0]).toContain("scan boom")
    // negative control: a mismatched event never reaches the rejecting storage and logs nothing
    await handlers[2]({ type: "session.idle", sessionID: "member-scout" })
    expect(logs).toHaveLength(1)
  })

  test("the team tool surface keeps the twelve V1 tool names", () => {
    expect(TEAM_TOOL_NAMES).toHaveLength(12)
  })
})
