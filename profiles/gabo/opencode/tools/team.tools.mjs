import { randomUUID } from "node:crypto"

const TEAM_TOOL_DESCRIPTIONS = Object.freeze({
  team_create: "Create a team run from team members that work as coordinated sessions.",
  team_delete: "Delete a team and its recorded state.",
  team_shutdown_request: "Request a coordinated shutdown of the team.",
  team_approve_shutdown: "Approve a pending team shutdown request.",
  team_reject_shutdown: "Reject a pending team shutdown request.",
  team_send_message: "Send a message to a team member or broadcast it to the team.",
  team_task_create: "Create a task inside a team task list.",
  team_task_list: "List the tasks of a team.",
  team_task_update: "Update a task in a team task list.",
  team_task_get: "Get the tasks of a team.",
  team_status: "Get the full status of a team: members, messages and tasks.",
  team_list: "List every team known to the runtime.",
})

const TEAM_TOOL_NAMES = Object.freeze([
  "team_create", "team_delete", "team_shutdown_request", "team_approve_shutdown",
  "team_reject_shutdown", "team_send_message", "team_task_create", "team_task_list",
  "team_task_update", "team_task_get", "team_status", "team_list",
])

// The native V2 team model persists each team as one storage record under
// `rigel-v2/team/<name>` with: members (name + sessionID + status), messages
// (id + from + to + text + read) and tasks. The event handlers in
// `rigel-v2-team-events.mjs` read the same records, so the tool surface and
// the coordination surface share one persistence model.

function teamKey(name) {
  return `rigel-v2/team/${name}`
}

function teamName(input) {
  const value = input?.team_name ?? input?.name
  if (typeof value !== "string" || !value.trim()) throw new Error("team_name is required")
  return value.trim()
}

async function readTeam(storage, name) {
  const team = await storage.get(teamKey(name))
  if (!team || typeof team !== "object") throw new Error(`Team \"${name}\" was not found`)
  return team
}

function normalizeMember(member) {
  if (typeof member === "string") {
    if (!member.trim()) throw new Error("member names must be non-empty strings")
    return { name: member.trim(), sessionID: undefined, status: "pending" }
  }
  const name = typeof member?.name === "string" ? member.name.trim() : ""
  if (!name) throw new Error("each member needs a non-empty name")
  const sessionID = typeof member?.sessionID === "string" && member.sessionID.trim() ? member.sessionID.trim() : undefined
  return { name, sessionID, status: "running" }
}

function normalizeMembers(input) {
  const raw = input?.members
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error("members must be an array")
  const seen = new Set()
  const members = []
  for (const entry of raw) {
    const member = normalizeMember(entry)
    if (seen.has(member.name)) throw new Error(`duplicate member name \"${member.name}\"`)
    seen.add(member.name)
    members.push(member)
  }
  return members
}

function definition(name, execute) {
  return {
    name,
    options: { codemode: false },
    description: TEAM_TOOL_DESCRIPTIONS[name],
    input: { type: "object", properties: { team_name: { type: "string" }, name: { type: "string" }, message: { type: "string" }, task: {} }, additionalProperties: true },
    execute,
  }
}

export { TEAM_TOOL_NAMES }

export function createTeamTools({ storage, getSessionID = () => undefined } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") throw new Error("V2 storage is required for team tools")
  const list = async () => {
    if (typeof storage.scan !== "function") return []
    const result = await storage.scan({ prefix: "rigel-v2/team/" })
    return (result?.entries ?? []).map((entry) => entry.value).filter((value) => value && typeof value === "object")
  }
  return {
    team_create: definition("team_create", async (input) => {
      const name = teamName(input)
      const existing = await storage.get(teamKey(name))
      if (existing) throw new Error(`Team \"${name}\" already exists`)
      const members = normalizeMembers(input)
      const team = { name, leaderSessionID: getSessionID(), status: "active", members, messages: [], tasks: [] }
      await storage.set(teamKey(name), team)
      return team
    }),
    team_delete: definition("team_delete", async (input) => {
      const name = teamName(input)
      if (typeof storage.remove !== "function") throw new Error("V2 storage remove is unavailable")
      await storage.remove(teamKey(name))
      return { name, deleted: true }
    }),
    team_shutdown_request: definition("team_shutdown_request", async (input) => {
      const name = teamName(input); const team = await readTeam(storage, name)
      const next = { ...team, status: "shutdown-requested" }; await storage.set(teamKey(name), next); return next
    }),
    team_approve_shutdown: definition("team_approve_shutdown", async (input) => {
      const name = teamName(input); const team = await readTeam(storage, name)
      const next = { ...team, status: "shutdown-approved" }; await storage.set(teamKey(name), next); return next
    }),
    team_reject_shutdown: definition("team_reject_shutdown", async (input) => {
      const name = teamName(input); const team = await readTeam(storage, name)
      const next = { ...team, status: "active" }; await storage.set(teamKey(name), next); return next
    }),
    team_send_message: definition("team_send_message", async (input) => {
      const name = teamName(input); const team = await readTeam(storage, name)
      const text = typeof input.message === "string" ? input.message : ""
      if (!text) throw new Error("message is required")
      const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : undefined
      if (to !== undefined && !(team.members ?? []).some((member) => member.name === to) && to !== "lead") {
        throw new Error(`member \"${to}\" is not part of team \"${name}\"`)
      }
      const message = { id: randomUUID(), from: getSessionID(), to, text, read: false }
      const next = { ...team, messages: [...(team.messages ?? []), message] }; await storage.set(teamKey(name), next)
      return { messageId: message.id, to: message.to, team: next }
    }),
    team_task_create: definition("team_task_create", async (input) => {
      const name = teamName(input); const team = await readTeam(storage, name)
      const task = { id: randomUUID(), ...(input.task && typeof input.task === "object" ? input.task : {}), status: "open" }
      const next = { ...team, tasks: [...(team.tasks ?? []), task] }; await storage.set(teamKey(name), next); return task
    }),
    team_task_list: definition("team_task_list", async (input) => (await readTeam(storage, teamName(input))).tasks ?? []),
    team_task_update: definition("team_task_update", async (input) => {
      const name = teamName(input); const team = await readTeam(storage, name); const task = input.task
      if (!task || typeof task !== "object" || typeof task.id !== "string") throw new Error("task.id is required")
      const tasks = (team.tasks ?? []).map((entry) => entry.id === task.id ? { ...entry, ...task } : entry)
      const next = { ...team, tasks }; await storage.set(teamKey(name), next); return tasks.find((entry) => entry.id === task.id)
    }),
    team_task_get: definition("team_task_get", async (input) => (await readTeam(storage, teamName(input))).tasks ?? []),
    team_status: definition("team_status", async (input) => await readTeam(storage, teamName(input))),
    team_list: definition("team_list", async () => await list()),
  }
}
