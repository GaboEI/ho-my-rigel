/**
 * Native OpenCode V2 `session_*` tools.
 *
 * Ports the observable semantics of
 * `packages/omo-opencode/src/tools/session-manager/tools.ts` onto the V2
 * session domain (`context.session.list/get/messages`). The V1 tool read
 * OpenCode's on-disk/SDK storage directly; V2 exposes the same data through
 * the plugin session domain, so this module adapts the V2 shapes to the V1
 * formatter contracts instead of re-reading storage.
 *
 * Preserved V1 behavior:
 *   - `session_list`: project filter, `from_date`/`to_date` window, `limit`,
 *     and the exact markdown table format.
 *   - `session_read`: `session_id` required, `include_todos`, `limit` with
 *     `from_end` slicing, and the `Session not found:` error string.
 *   - `session_search`: `query` required, optional `session_id` scope,
 *     `case_sensitive`, `limit` (default 20), 60s timeout, and the
 *     `Found N matches:` format.
 *   - `session_info`: `session_id` required, the `Session not found:` error,
 *     and the exact info block.
 *
 * Every tool returns a string (V1 contract) and never throws for a normal
 * error: a failure becomes `Error: <message>`, matching V1.
 */

import {
  formatSessionList,
  formatSessionMessages,
  formatSessionInfo,
  formatSearchResults,
  searchInMessages,
  buildSessionInfo,
} from "./session-formatter.mjs"

const SEARCH_TIMEOUT_MS = 60_000
const MAX_SESSIONS_TO_SCAN = 50
const DEFAULT_SEARCH_LIMIT = 20

export const SESSION_LIST_DESCRIPTION = `List all OpenCode sessions with optional filtering.

Returns a list of available session IDs with metadata including message count, date range, and agents used.

Arguments:
- limit (optional): Maximum number of sessions to return
- from_date (optional): Filter sessions from this date (ISO 8601 format)
- to_date (optional): Filter sessions until this date (ISO 8601 format)

Example output:
| Session ID | Messages | First | Last | Agents |
|------------|----------|-------|------|--------|
| ses_abc123 | 45 | 2025-12-20 | 2025-12-24 | build, oracle |
| ses_def456 | 12 | 2025-12-19 | 2025-12-19 | build |`

export const SESSION_READ_DESCRIPTION = `Read messages and history from an OpenCode session.

Returns a formatted view of session messages with role, timestamp, and content. Optionally includes todos and transcript data.

Arguments:
- session_id (required): Session ID to read
- include_todos (optional): Include todo list if available (default: false)
- include_transcript (optional): Include transcript log if available (default: false)
- limit (optional): Maximum number of messages to return (default: all)

Example output:
Session: ses_abc123
Messages: 45
Date Range: 2025-12-20 to 2025-12-24

[Message 1] user (2025-12-20 10:30:00)
Hello, can you help me with...

[Message 2] assistant (2025-12-20 10:30:15)
Of course! Let me help you with...`

export const SESSION_SEARCH_DESCRIPTION = `Search for content within OpenCode session messages.

Performs full-text search across session messages and returns matching excerpts with context.

Arguments:
- query (required): Search query string
- session_id (optional): Search within specific session only (default: all sessions)
- case_sensitive (optional): Case-sensitive search (default: false)
- limit (optional): Maximum number of results to return (default: 20)

Example output:
Found 3 matches across 2 sessions:

[ses_abc123] Message msg_001 (user)
...implement the **session manager** tool...

[ses_abc123] Message msg_005 (assistant)
...I'll create a **session manager** with full search...

[ses_def456] Message msg_012 (user)
...use the **session manager** to find...`

export const SESSION_INFO_DESCRIPTION = `Get metadata and statistics about an OpenCode session.

Returns detailed information about a session including message count, date range, agents used, and available data sources.

Arguments:
- session_id (required): Session ID to inspect

Example output:
Session ID: ses_abc123
Messages: 45
Date Range: 2025-12-20 10:30:00 to 2025-12-24 15:45:30
Duration: 4 days, 5 hours
Agents Used: build, oracle, librarian
Has Todos: Yes (12 items, 8 completed)
Has Transcript: Yes (234 entries)`

function withTimeout(promise, ms, operation) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)),
  ])
}

function responseData(response) {
  if (response && typeof response === "object" && "data" in response) return response.data
  return response
}

function asArray(value) {
  if (Array.isArray(value)) return value
  const data = responseData(value)
  return Array.isArray(data) ? data : []
}

function sessionIdOf(session) {
  return session?.id ?? session?.sessionID ?? session?.session?.id
}

function sessionUpdatedAt(session) {
  const updated = session?.time?.updated ?? session?.time?.created
  return typeof updated === "number" ? updated : undefined
}

function normalizeProjectFilter(directory) {
  if (directory === "/") return undefined
  return directory
}

/**
 * Resolve the V2 session domain from a client. The plugin setup context is the
 * typed service surface; `client.session` is the compatible fallback. A host
 * that exposes neither is a hard error, never a silent empty result.
 */
function sessionDomain(client) {
  const api = client?.session ?? client?.v2?.session
  if (typeof api?.list !== "function") {
    throw new Error("OpenCode V2 session.list is unavailable")
  }
  return api
}

async function listSessions(client, directory) {
  const api = sessionDomain(client)
  const response = await api.list(directory ? { directory } : undefined)
  return asArray(response)
}

async function getSession(client, sessionID) {
  const api = sessionDomain(client)
  if (typeof api.get !== "function") return undefined
  try {
    return responseData(await api.get({ sessionID }))
  } catch {
    return undefined
  }
}

async function getMessages(client, sessionID) {
  const api = sessionDomain(client)
  if (typeof api.messages !== "function") return []
  return asArray(await api.messages({ sessionID }))
}

/**
 * V1's `formatSessionList` called `getSessionInfo(id)` per session, which read
 * the session's messages to derive `message_count` and `agents_used`. V2's
 * `session.list` does not return those fields, so this computes them from
 * `session.messages` to preserve the V1 table columns.
 */
async function enrichSession(client, session) {
  const id = sessionIdOf(session)
  if (typeof id !== "string" || !id) return session
  if (typeof session?.message_count === "number" && Array.isArray(session?.agents_used)) return session
  let messages = []
  try {
    messages = await getMessages(client, id)
  } catch {
    messages = []
  }
  const agents = new Set()
  let first
  let last
  for (const message of messages) {
    const agent = message?.agent ?? message?.info?.agent
    if (agent) agents.add(agent)
    const created = message?.time?.created ?? message?.created
    if (typeof created === "number") {
      if (first === undefined || created < first) first = created
      if (last === undefined || created > last) last = created
    }
  }
  return {
    ...session,
    message_count: messages.length,
    agents_used: Array.from(agents),
    first_message: session?.first_message ?? first,
    last_message: session?.last_message ?? last,
  }
}

/**
 * Build the four `session_*` tool definitions. `clients` is the ordered list of
 * candidate V2 clients (setup context first, then the compatible client), so a
 * host that exposes the session domain on either surface works.
 */
export function createSessionTools({ clients, directory }) {
  const resolveClient = () => {
    for (const client of clients.filter(Boolean)) {
      if (typeof client?.session?.list === "function" || typeof client?.v2?.session?.list === "function") return client
    }
    throw new Error("OpenCode V2 session domain is unavailable")
  }

  const session_list = {
    description: SESSION_LIST_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of sessions to return" },
        from_date: { type: "string", description: "Filter sessions from this date (ISO 8601 format)" },
        to_date: { type: "string", description: "Filter sessions until this date (ISO 8601 format)" },
        project_path: { type: "string", description: "Filter sessions by project path (default: current working directory)" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const client = resolveClient()
        const projectFilter = normalizeProjectFilter(args.project_path ?? directory)
        let sessions = await listSessions(client, projectFilter)
        if (args.from_date || args.to_date) {
          const from = args.from_date ? new Date(args.from_date).getTime() : undefined
          const to = args.to_date ? new Date(args.to_date).getTime() : undefined
          sessions = sessions.filter((session) => {
            const updated = sessionUpdatedAt(session)
            if (updated === undefined) return false
            if (from !== undefined && updated < from) return false
            if (to !== undefined && updated > to) return false
            return true
          })
        }
        if (typeof args.limit === "number" && args.limit > 0) sessions = sessions.slice(0, args.limit)
        const enriched = await Promise.all(sessions.map((session) => enrichSession(client, session)))
        return formatSessionList(enriched)
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

  const session_read = {
    description: SESSION_READ_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to read" },
        include_todos: { type: "boolean", description: "Include todo list if available (default: false)" },
        include_transcript: { type: "boolean", description: "Include transcript log if available (default: false)" },
        limit: { type: "number", description: "Maximum number of messages to return (default: all messages)" },
        from_end: { type: "boolean", description: "Read messages from the END of the session (default: false)." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const client = resolveClient()
        const sessionID = args.session_id
        if (typeof sessionID !== "string" || !sessionID) return "Error: Missing required parameter 'session_id'."
        const session = await getSession(client, sessionID)
        let messages = await getMessages(client, sessionID)
        if (!session && messages.length === 0) return `Session not found: ${sessionID}`
        if (messages.length === 0) return `Session not found: ${sessionID}`
        if (typeof args.limit === "number" && args.limit > 0) {
          messages = args.from_end ? messages.slice(-args.limit) : messages.slice(0, args.limit)
        }
        return formatSessionMessages(messages, args.include_todos === true, [])
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

  const session_search = {
    description: SESSION_SEARCH_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        session_id: { type: "string", description: "Search within specific session only (default: all sessions)" },
        case_sensitive: { type: "boolean", description: "Case-sensitive search (default: false)" },
        limit: { type: "number", description: "Maximum number of results to return (default: 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const client = resolveClient()
        const query = args.query
        if (typeof query !== "string" || !query) return "Error: Missing required parameter 'query'."
        const resultLimit = typeof args.limit === "number" && args.limit > 0 ? args.limit : DEFAULT_SEARCH_LIMIT
        const searchOperation = async () => {
          if (args.session_id) {
            return searchInMessages(args.session_id, await getMessages(client, args.session_id), query, args.case_sensitive === true, resultLimit)
          }
          const sessions = (await listSessions(client, undefined)).slice(0, MAX_SESSIONS_TO_SCAN)
          const allResults = []
          for (const session of sessions) {
            if (allResults.length >= resultLimit) break
            const sessionID = sessionIdOf(session)
            if (typeof sessionID !== "string" || !sessionID) continue
            const remaining = resultLimit - allResults.length
            const sessionResults = searchInMessages(sessionID, await getMessages(client, sessionID), query, args.case_sensitive === true, remaining)
            allResults.push(...sessionResults)
          }
          return allResults.slice(0, resultLimit)
        }
        const results = await withTimeout(searchOperation(), SEARCH_TIMEOUT_MS, "Search")
        return formatSearchResults(results)
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

  const session_info = {
    description: SESSION_INFO_DESCRIPTION,
    input: {
      type: "object",
      properties: { session_id: { type: "string", description: "Session ID to inspect" } },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const client = resolveClient()
        const sessionID = args.session_id
        if (typeof sessionID !== "string" || !sessionID) return "Error: Missing required parameter 'session_id'."
        const messages = await getMessages(client, sessionID)
        const session = await getSession(client, sessionID)
        if (!session && messages.length === 0) return `Session not found: ${sessionID}`
        return formatSessionInfo(buildSessionInfo(sessionID, messages))
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

  return { session_list, session_read, session_search, session_info }
}
