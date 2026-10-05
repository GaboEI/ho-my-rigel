/**
 * Native V2 team gating and context injectors (correction H2; V1 parity:
 * `hooks/team-tool-gating/hook.ts`, `hooks/team-mailbox-injector/hook.ts`,
 * `hooks/team-mode-status-injector/hook.ts`), operating on the native team
 * storage model written by `tools/team.tools.mjs` (team name as the key,
 * `leaderSessionID` for the lead, `member.sessionID` for members).
 *
 * Gating policy (tool.execute.before rule, team_mode gate):
 * - `team_create`: denied when the calling session is already a participant
 *   (lead or member) of any team.
 * - `team_delete` / `team_shutdown_request`: lead of the named team only.
 * - `team_approve_shutdown` / `team_reject_shutdown`: lead or member of the
 *   named team.
 * - `team_list`: open.
 * - universal tools (send / task_create / task_list / task_update /
 *   task_get / status): any participant of the named team.
 * - any other `team_*` tool: participant of the named team.
 * A denial throws, which blocks the tool call in the V2 execute.before chain.
 *
 * Injectors (context hook): for a member session, unread routed messages are
 * prepended to the last real user message as a `<team-mailbox>` block and
 * marked read (the injection IS the delivery, V1 poll-and-inject parity). For
 * any participant (lead or member), a `<team-status>` block with the team
 * status and member states is prepended. Injectors are no-ops for
 * non-participants, so ordinary sessions pay nothing.
 */

const TEAM_PREFIX = "rigel-v2/team/"

async function listTeams(storage) {
  if (!storage || typeof storage.scan !== "function") return []
  const result = await storage.scan({ prefix: TEAM_PREFIX })
  return (result?.entries ?? [])
    .map((entry) => entry.value)
    .filter((value) => value && typeof value === "object")
}

function participantOf(team, sessionID) {
  if (team.leaderSessionID === sessionID) return "lead"
  if ((team.members ?? []).some((member) => member?.sessionID === sessionID)) return "member"
  return undefined
}

async function resolveParticipant(storage, sessionID) {
  for (const team of await listTeams(storage)) {
    const role = participantOf(team, sessionID)
    if (role) return { role, team }
  }
  return { role: undefined }
}

async function teamByName(storage, name) {
  if (typeof name !== "string" || !name.trim()) return undefined
  return storage.get(`${TEAM_PREFIX}${name.trim()}`)
}

export function resolveNativeTeamParticipant(team, sessionID) {
  return participantOf(team, sessionID) ?? "neither"
}

function isRealUserMessage(message) {
  return message?.role === "user" && message.synthetic !== true && message.internal !== true
}

function prependToLastUserMessage(event, block) {
  if (!Array.isArray(event?.messages)) return false
  const message = [...event.messages].reverse().find(isRealUserMessage)
  if (!message) return false
  const separator = "\n\n---\n\n"
  if (typeof message.content === "string") {
    message.content = `${block}${separator}${message.content}`
    return true
  }
  if (!Array.isArray(message.content)) return false
  const text = message.content.find((part) => part?.type === "text" && typeof part.text === "string")
  if (!text) return false
  text.text = `${block}${separator}${text.text}`
  return true
}

export function createNativeTeamGatingRule({ storage } = {}) {
  if (!storage || typeof storage.get !== "function") {
    throw new Error("V2 storage is required for native team gating")
  }
  return {
    name: "team-tool-gating",
    async run(event) {
      const toolName = typeof event?.tool === "string" ? event.tool : ""
      if (!toolName.startsWith("team_")) return
      const sessionID = event?.sessionID
      const participant = await resolveParticipant(storage, sessionID)

      if (toolName === "team_create") {
        if (participant.role !== undefined) {
          throw new Error(`team_create denied: session is already a participant of team ${participant.team.name}`)
        }
        return
      }

      const team = await teamByName(storage, event?.input?.team_name ?? event?.input?.name)

      if (toolName === "team_delete" || toolName === "team_shutdown_request") {
        if (!team || participantOf(team, sessionID) !== "lead") {
          throw new Error(`${toolName} is lead-only`)
        }
        return
      }

      if (toolName === "team_approve_shutdown" || toolName === "team_reject_shutdown") {
        if (!team || participantOf(team, sessionID) === undefined) {
          throw new Error(`${toolName}: caller must be a participant of team ${team?.name ?? "(unknown)"}`)
        }
        return
      }

      if (toolName === "team_list") return

      if (!team || participantOf(team, sessionID) === undefined) {
        throw new Error(`${toolName} requires participation in team ${team?.name ?? "(unknown)"}`)
      }
    },
  }
}

export function createNativeTeamMailboxInjector({ storage } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("V2 storage is required for native team mailbox injection")
  }
  return async (event) => {
    if (!Array.isArray(event?.messages) || typeof event.sessionID !== "string") return
    for (const team of await listTeams(storage)) {
      const member = (team.members ?? []).find((entry) => entry?.sessionID === event.sessionID)
      if (!member) continue
      const unread = (team.messages ?? []).filter((message) => message?.to === member.name && message.read === false)
      if (unread.length === 0) continue
      const block = `<team-mailbox team="${team.name}">\n${unread.map((message) => `- from ${message.from ?? "unknown"}: ${message.text}`).join("\n")}\n</team-mailbox>`
      if (prependToLastUserMessage(event, block)) {
        await storage.set(`${TEAM_PREFIX}${team.name}`, {
          ...team,
          messages: (team.messages ?? []).map((message) => message?.to === member.name && message.read === false ? { ...message, read: true } : message),
        })
      }
      return
    }
  }
}

export function createNativeTeamStatusInjector({ storage } = {}) {
  if (!storage || typeof storage.scan !== "function") {
    throw new Error("V2 storage is required for native team status injection")
  }
  return async (event) => {
    if (!Array.isArray(event?.messages) || typeof event.sessionID !== "string") return
    for (const team of await listTeams(storage)) {
      if (participantOf(team, event.sessionID) === undefined) continue
      const members = (team.members ?? [])
        .map((member) => `- ${member.name}: ${member.status}${member.error ? ` (${member.error})` : ""}`)
        .join("\n")
      const block = `<team-status team="${team.name}" status="${team.status}">\n${members || "(no members)"}\n</team-status>`
      prependToLastUserMessage(event, block)
      return
    }
  }
}
