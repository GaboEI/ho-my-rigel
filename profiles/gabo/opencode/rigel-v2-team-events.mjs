/**
 * Native V2 team event handlers (Phase-4 Ola 6): the native counterparts of the
 * four V1 team-session-event handlers, operating on the native team storage
 * model written by `tools/team.tools.mjs`:
 *
 * - idle wake hint  (`session.idle`): a member session that goes idle with
 *   unread routed messages receives one queued wake prompt; the wake marks the
 *   messages read (the native ack) and is suppressed for 30s per team:member
 *   (V1 `WAKE_HINT_DUPLICATE_SUPPRESSION_MS` parity).
 * - member status   (`session.idle` / `session.deleted`): running -> idle and
 *   running|idle|pending -> completed transitions.
 * - member error    (`session.error`): marks the member `errored` and records
 *   the error text; unread messages stay unread, so a resumed member is woken
 *   again by the idle handler.
 * - lead orphan     (`session.deleted`): the leader session's deletion marks
 *   the team `orphaned`.
 *
 * Each handler is error-isolated: a throwing handler is logged and never
 * aborts the shared event loop.
 */

const TEAM_PREFIX = "rigel-v2/team/"
const WAKE_HINT_DUPLICATE_SUPPRESSION_MS = 30_000

function wakeHint(unreadCount) {
  return `You have ${unreadCount} new team messages. They will be injected on your next turn.`
}

async function listTeams(storage) {
  if (!storage || typeof storage.scan !== "function") return []
  const result = await storage.scan({ prefix: TEAM_PREFIX })
  return (result?.entries ?? [])
    .map((entry) => entry.value)
    .filter((value) => value && typeof value === "object")
}

async function memberForSession(storage, sessionID) {
  for (const team of await listTeams(storage)) {
    const member = (team.members ?? []).find((entry) => entry?.sessionID === sessionID)
    if (member) return { team, member }
  }
  return null
}

async function saveTeam(storage, team) {
  await storage.set(`${TEAM_PREFIX}${team.name}`, team)
}

function isUnreadFor(message, memberName) {
  return message && typeof message === "object" && message.to === memberName && message.read === false
}

/**
 * Build the native team event handler set.
 *
 * Returns an array of `(event) => Promise<void>` handlers designed for the
 * shared runtime event loop (no second `event.subscribe`). Every handler
 * receives the enriched event the loop already produced (`event.type` +
 * `event.sessionID`).
 */
export function createNativeTeamEventHandlers({ storage, session, log = console.error } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("V2 storage is required for native team event handlers")
  }
  const recentWakeHints = new Map()

  const handler = (name, body) => async (event) => {
    try {
      await body(event)
    } catch (error) {
      log(`[oh-my-rigel] Native V2 team event handler "${name}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const idleWakeHint = handler("idle-wake-hint", async (event) => {
    if (event?.type !== "session.idle" || typeof event.sessionID !== "string") return
    const found = await memberForSession(storage, event.sessionID)
    if (!found) return
    const { team, member } = found
    const unread = (team.messages ?? []).filter((message) => isUnreadFor(message, member.name))
    if (unread.length === 0) return
    const suppressionKey = `${team.name}:${member.name}`
    const now = Date.now()
    const lastWake = recentWakeHints.get(suppressionKey)
    if (typeof lastWake === "number" && now - lastWake < WAKE_HINT_DUPLICATE_SUPPRESSION_MS) return
    recentWakeHints.set(suppressionKey, now)
    if (typeof session?.prompt !== "function") return
    await session.prompt({ sessionID: event.sessionID, text: wakeHint(unread.length), delivery: "queue" })
    // The queued wake prompt IS the delivery: marking the routed messages read
    // here is the native ack, so the next idle does not re-wake for them.
    await saveTeam(storage, {
      ...team,
      messages: (team.messages ?? []).map((message) => isUnreadFor(message, member.name) ? { ...message, read: true } : message),
    })
    log(`[oh-my-rigel] Native V2 team wake hint: team=${team.name}; member=${member.name}; unread=${unread.length}`)
  })

  const memberStatus = handler("member-status", async (event) => {
    if (typeof event?.sessionID !== "string") return
    if (event.type !== "session.idle" && event.type !== "session.deleted") return
    const found = await memberForSession(storage, event.sessionID)
    if (!found) return
    const { team, member } = found
    if (event.type === "session.idle") {
      if (member.status !== "running") return
      await saveTeam(storage, {
        ...team,
        members: (team.members ?? []).map((entry) => entry.name === member.name ? { ...entry, status: "idle" } : entry),
      })
      return
    }
    if (!["running", "idle", "pending"].includes(member.status)) return
    await saveTeam(storage, {
      ...team,
      members: (team.members ?? []).map((entry) => entry.name === member.name ? { ...entry, status: "completed" } : entry),
    })
  })

  const memberError = handler("member-error", async (event) => {
    if (event?.type !== "session.error" || typeof event.sessionID !== "string") return
    const found = await memberForSession(storage, event.sessionID)
    if (!found) return
    const { team, member } = found
    const errorText = typeof event?.data?.error === "string" && event.data.error
      ? event.data.error
      : "unknown error"
    await saveTeam(storage, {
      ...team,
      members: (team.members ?? []).map((entry) => entry.name === member.name ? { ...entry, status: "errored", error: errorText } : entry),
    })
    log(`[oh-my-rigel] Native V2 team member errored: team=${team.name}; member=${member.name}; error=${errorText}`)
  })

  const leadOrphan = handler("lead-orphan", async (event) => {
    if (event?.type !== "session.deleted" || typeof event.sessionID !== "string") return
    for (const team of await listTeams(storage)) {
      if (team.leaderSessionID !== event.sessionID || team.status === "orphaned") continue
      await saveTeam(storage, { ...team, status: "orphaned" })
      log(`[oh-my-rigel] Native V2 team lead orphaned: team=${team.name}`)
    }
  })

  return [idleWakeHint, memberStatus, memberError, leadOrphan]
}
