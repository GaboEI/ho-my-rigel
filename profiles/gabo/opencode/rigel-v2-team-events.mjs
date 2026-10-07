/**
 * Native V2 team event handlers, operating on the native team storage model
 * written by `tools/team.tools.mjs`.
 *
 * Teams are namespaced per project (`rigel-v2/team/<projectKey>/<name>`). A
 * session belongs to exactly one team, so every handler LOCATES the team by the
 * event's session id across all project namespaces and mutates ONLY that team at
 * its own key. Two projects with a team of the same name therefore never see each
 * other's events, and project A's event never touches project B's records.
 *
 * Handlers (V1 team-session-events parity):
 * - idle wake hint  (`session.idle`): unread routed messages -> one queued wake.
 * - member status   (`session.idle` / `session.deleted`): running -> idle ->
 *   completed transitions.
 * - member error    (`session.error`): marks the member `errored` with the text.
 * - lead orphan     (`session.deleted`): the leader's deletion orphans the team
 *   and reclaims its worktrees through the owning repo's reconciler (durable
 *   journal first, retried on startup if the process dies).
 *
 * Each handler is error-isolated: a throwing handler is logged and never aborts
 * the shared event loop.
 */

import { TEAM_RECORD_ROOT } from "./rigel-v2-team-project-scope.mjs"

const WAKE_HINT_DUPLICATE_SUPPRESSION_MS = 30_000

function wakeHint(unreadCount) {
  return `You have ${unreadCount} new team messages. They will be injected on your next turn.`
}

function isUnreadFor(message, memberName) {
  return message && typeof message === "object" && message.to === memberName && message.read === false
}

async function scanAllTeamEntries(storage) {
  if (!storage || typeof storage.scan !== "function") return []
  const result = await storage.scan({ prefix: TEAM_RECORD_ROOT })
  return (result?.entries ?? [])
    .filter((entry) => entry && typeof entry.key === "string" && entry.value && typeof entry.value === "object")
    .map((entry) => ({ key: entry.key, team: entry.value }))
}

/**
 * Build the native team event handler set.
 *
 * Returns an array of `(event) => Promise<void>` handlers designed for the
 * shared runtime event loop (no second `event.subscribe`).
 */
export function createNativeTeamEventHandlers({ storage, session, scopeRegistry, worktrees, reconciler, log = console.error } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("V2 storage is required for native team event handlers")
  }
  const recentWakeHints = new Map()

  const listTeamEntries = () => scanAllTeamEntries(storage)
  const saveTeam = async (key, team) => { await storage.set(key, team) }

  const memberForSession = async (sessionID) => {
    for (const { key, team } of await listTeamEntries()) {
      const member = (team.members ?? []).find((entry) => entry?.sessionID === sessionID)
      if (member) return { key, team, member }
    }
    return null
  }

  // Prefer the owning repo's reconciler (from the registry); injected reconciler
  // is the single-repo fallback. Await the repo's initial reconciliation so the
  // orphan cleanup never races the startup sweep.
  const reconcilerFor = async (team) => {
    if (scopeRegistry && typeof team?.repoRoot === "string" && team.repoRoot) {
      try {
        const scope = await scopeRegistry.forRepoRoot(team.repoRoot)
        if (scope.ready) await scope.ready
        return scope.reconciler
      } catch { /* fall through */ }
    }
    return reconciler
  }

  const handler = (name, body) => async (event) => {
    try {
      await body(event)
    } catch (error) {
      log(`[oh-my-rigel] Native V2 team event handler "${name}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const idleWakeHint = handler("idle-wake-hint", async (event) => {
    if (event?.type !== "session.idle" || typeof event.sessionID !== "string") return
    const found = await memberForSession(event.sessionID)
    if (!found) return
    const { key, team, member } = found
    const unread = (team.messages ?? []).filter((message) => isUnreadFor(message, member.name))
    if (unread.length === 0) return
    const suppressionKey = `${key}:${member.name}`
    const now = Date.now()
    const lastWake = recentWakeHints.get(suppressionKey)
    if (typeof lastWake === "number" && now - lastWake < WAKE_HINT_DUPLICATE_SUPPRESSION_MS) return
    recentWakeHints.set(suppressionKey, now)
    if (typeof session?.prompt !== "function") return
    await session.prompt({ sessionID: event.sessionID, text: wakeHint(unread.length), delivery: "queue" })
    await saveTeam(key, {
      ...team,
      messages: (team.messages ?? []).map((message) => isUnreadFor(message, member.name) ? { ...message, read: true } : message),
    })
    log(`[oh-my-rigel] Native V2 team wake hint: team=${team.name}; member=${member.name}; unread=${unread.length}`)
  })

  const memberStatus = handler("member-status", async (event) => {
    if (typeof event?.sessionID !== "string") return
    if (event.type !== "session.idle" && event.type !== "session.deleted") return
    const found = await memberForSession(event.sessionID)
    if (!found) return
    const { key, team, member } = found
    if (event.type === "session.idle") {
      if (member.status !== "running") return
      await saveTeam(key, {
        ...team,
        members: (team.members ?? []).map((entry) => entry.name === member.name ? { ...entry, status: "idle" } : entry),
      })
      return
    }
    if (!["running", "idle", "pending"].includes(member.status)) return
    await saveTeam(key, {
      ...team,
      members: (team.members ?? []).map((entry) => entry.name === member.name ? { ...entry, status: "completed" } : entry),
    })
  })

  const memberError = handler("member-error", async (event) => {
    if (event?.type !== "session.error" || typeof event.sessionID !== "string") return
    const found = await memberForSession(event.sessionID)
    if (!found) return
    const { key, team, member } = found
    const errorText = typeof event?.data?.error === "string" && event.data.error ? event.data.error : "unknown error"
    await saveTeam(key, {
      ...team,
      members: (team.members ?? []).map((entry) => entry.name === member.name ? { ...entry, status: "errored", error: errorText } : entry),
    })
    log(`[oh-my-rigel] Native V2 team member errored: team=${team.name}; member=${member.name}; error=${errorText}`)
  })

  const leadOrphan = handler("lead-orphan", async (event) => {
    if (event?.type !== "session.deleted" || typeof event.sessionID !== "string") return
    for (const { key, team } of await listTeamEntries()) {
      if (team.leaderSessionID !== event.sessionID || team.status === "orphaned") continue
      await saveTeam(key, { ...team, status: "orphaned" })
      log(`[oh-my-rigel] Native V2 team lead orphaned: team=${team.name}`)
      const rec = await reconcilerFor(team)
      if (rec) {
        try {
          await rec.record({ teamName: team.name, members: team.members, reason: "orphan" })
        } catch (error) {
          log(`[oh-my-rigel] Native V2 team worktree journal record failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        void rec.runPending({ teamName: team.name, members: team.members, reason: "orphan" })
      } else {
        worktrees?.cleanupNonBlocking?.({ members: team.members })
      }
    }
  })

  return [idleWakeHint, memberStatus, memberError, leadOrphan]
}
