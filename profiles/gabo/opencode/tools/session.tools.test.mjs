import { expect, test } from "bun:test"
import { createSessionTools } from "./session.tools.mjs"

// A fake V2 session domain. `list` returns sessions; `get`/`messages` answer by
// id. This is the real boundary the tools consume, so the tests drive the tool
// executors against it rather than asserting on internal helpers.
function fakeClient({ sessions = [], messagesById = {} } = {}) {
  return {
    session: {
      list: async () => ({ data: sessions }),
      get: async ({ sessionID }) => ({ data: sessions.find((session) => session.id === sessionID) }),
      messages: async ({ sessionID }) => ({ data: messagesById[sessionID] ?? [] }),
    },
  }
}

function message(id, role, text, created, agent) {
  return { id, role, agent, time: { created }, parts: [{ type: "text", text }] }
}

function toolsFor(client, directory = "/work") {
  return createSessionTools({ clients: [client], directory })
}

test("session_list renders the V1 markdown table for the project's sessions", async () => {
  const client = fakeClient({
    sessions: [
      { id: "ses_a", message_count: 2, time: { created: Date.parse("2026-01-01"), updated: Date.parse("2026-01-02") }, agents_used: ["build"] },
      { id: "ses_b", message_count: 1, time: { created: Date.parse("2026-02-01"), updated: Date.parse("2026-02-02") }, agents_used: [] },
    ],
  })
  const { session_list } = toolsFor(client)
  const output = await session_list.execute({})
  expect(output).toContain("| Session ID | Messages | First")
  expect(output).toContain("ses_a")
  expect(output).toContain("2026-01-02")
  expect(output).toContain("build")
  expect(output).toContain("none")
})

test("session_list applies limit and the from_date/to_date window", async () => {
  const client = fakeClient({
    sessions: [
      { id: "ses_old", message_count: 1, time: { updated: Date.parse("2026-01-01") } },
      { id: "ses_new", message_count: 1, time: { updated: Date.parse("2026-06-01") } },
    ],
  })
  const { session_list } = toolsFor(client)
  const windowed = await session_list.execute({ from_date: "2026-03-01" })
  expect(windowed).toContain("ses_new")
  expect(windowed).not.toContain("ses_old")
  const limited = await session_list.execute({ limit: 1 })
  expect(limited.split("\n").filter((line) => line.startsWith("| ses_")).length).toBe(1)
})

test("session_list reports no sessions instead of an empty table", async () => {
  const { session_list } = toolsFor(fakeClient({ sessions: [] }))
  expect(await session_list.execute({})).toBe("No sessions found.")
})

test("session_read returns the V1 message format and honors from_end slicing", async () => {
  const client = fakeClient({
    sessions: [{ id: "ses_a" }],
    messagesById: {
      ses_a: [
        message("m1", "user", "first", Date.parse("2026-01-01T00:00:00Z")),
        message("m2", "assistant", "second", Date.parse("2026-01-01T00:01:00Z"), "build"),
      ],
    },
  })
  const { session_read } = toolsFor(client)
  const output = await session_read.execute({ session_id: "ses_a" })
  expect(output).toContain("[user]")
  expect(output).toContain("first")
  expect(output).toContain("[assistant (build)]")
  const lastOnly = await session_read.execute({ session_id: "ses_a", limit: 1, from_end: true })
  expect(lastOnly).toContain("second")
  expect(lastOnly).not.toContain("first")
})

test("session_read returns the V1 not-found string for an unknown session", async () => {
  const { session_read } = toolsFor(fakeClient({ sessions: [] }))
  expect(await session_read.execute({ session_id: "ses_missing" })).toBe("Session not found: ses_missing")
})

test("session_read rejects a missing session_id with the V1 error", async () => {
  const { session_read } = toolsFor(fakeClient({ sessions: [] }))
  expect(await session_read.execute({})).toBe("Error: Missing required parameter 'session_id'.")
})

test("session_search finds matches with excerpts and the V1 result format", async () => {
  const client = fakeClient({
    sessions: [{ id: "ses_a" }],
    messagesById: {
      ses_a: [message("m1", "user", "please implement the session manager tool", Date.parse("2026-01-01"))],
    },
  })
  const { session_search } = toolsFor(client)
  const output = await session_search.execute({ query: "session manager" })
  expect(output).toContain("Found 1 matches:")
  expect(output).toContain("[ses_a] m1 (user)")
  expect(output).toContain("Matches: 1")
})

test("session_search is case-insensitive by default and case-sensitive on request", async () => {
  const client = fakeClient({
    sessions: [{ id: "ses_a" }],
    messagesById: { ses_a: [message("m1", "user", "ULTRAWORK", Date.parse("2026-01-01"))] },
  })
  const { session_search } = toolsFor(client)
  expect(await session_search.execute({ query: "ultrawork" })).toContain("Found 1 matches:")
  expect(await session_search.execute({ query: "ultrawork", case_sensitive: true })).toBe("No matches found.")
})

test("session_search scopes to one session when session_id is supplied", async () => {
  const client = fakeClient({
    sessions: [{ id: "ses_a" }, { id: "ses_b" }],
    messagesById: {
      ses_a: [message("m1", "user", "needle", Date.parse("2026-01-01"))],
      ses_b: [message("m2", "user", "needle", Date.parse("2026-01-01"))],
    },
  })
  const { session_search } = toolsFor(client)
  const output = await session_search.execute({ query: "needle", session_id: "ses_b" })
  expect(output).toContain("[ses_b]")
  expect(output).not.toContain("[ses_a]")
})

test("session_search rejects a missing query with the V1 error", async () => {
  const { session_search } = toolsFor(fakeClient({ sessions: [] }))
  expect(await session_search.execute({})).toBe("Error: Missing required parameter 'query'.")
})

test("session_info reports counts, agents, and duration", async () => {
  const client = fakeClient({
    sessions: [{ id: "ses_a" }],
    messagesById: {
      ses_a: [
        message("m1", "user", "a", Date.parse("2026-01-01T00:00:00Z")),
        message("m2", "assistant", "b", Date.parse("2026-01-03T00:00:00Z"), "oracle"),
      ],
    },
  })
  const { session_info } = toolsFor(client)
  const output = await session_info.execute({ session_id: "ses_a" })
  expect(output).toContain("Session ID: ses_a")
  expect(output).toContain("Messages: 2")
  expect(output).toContain("Agents Used: oracle")
  expect(output).toContain("Duration: 2 days, 0 hours")
})

test("session_info returns the V1 not-found string for an unknown session", async () => {
  const { session_info } = toolsFor(fakeClient({ sessions: [] }))
  expect(await session_info.execute({ session_id: "ses_missing" })).toBe("Session not found: ses_missing")
})

test("session tools surface a domain failure as the V1 Error string", async () => {
  const client = { session: { list: async () => { throw new Error("backend down") } } }
  const { session_list } = toolsFor(client)
  expect(await session_list.execute({})).toBe("Error: backend down")
})

// Task 15 re-open: V2's session.list omits message_count/agents_used, which V1
// derived from storage. The tool must compute them from session.messages so the
// V1 table columns are preserved.
test("session_list derives message_count and agents_used from session messages", async () => {
  const client = fakeClient({
    sessions: [{ id: "ses_a", time: { created: Date.parse("2026-01-01"), updated: Date.parse("2026-01-02") } }],
    messagesById: {
      ses_a: [
        message("m1", "user", "a", Date.parse("2026-01-01"), "build"),
        message("m2", "assistant", "b", Date.parse("2026-01-02"), "oracle"),
      ],
    },
  })
  const { session_list } = toolsFor(client)
  const output = await session_list.execute({})
  expect(output).toContain("| 2 ")
  expect(output).toContain("build, oracle")
})
