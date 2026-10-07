import { randomUUID } from "node:crypto"
import { DEFAULT_PROJECT_KEY, teamRecordKey, teamRecordsPrefix } from "../rigel-v2-team-project-scope.mjs"

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

// Each team is a storage record namespaced by the SESSION's project:
// `rigel-v2/team/<projectKey>/<name>`. The active scope (project key, repo root,
// worktree manager, reconciler) is resolved per tool call from the calling
// session's directory, so two repos served by one plugin instance never collide.
function teamName(input) {
  const value = input?.team_name ?? input?.name
  if (typeof value !== "string" || !value.trim()) throw new Error("team_name is required")
  return value.trim()
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

export function createTeamTools({ storage, getSessionID = () => undefined, resolveScopeForSession, worktreeManager, worktreeReconciler, projectKey = DEFAULT_PROJECT_KEY, log = (line) => console.error(line) } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") throw new Error("V2 storage is required for team tools")

  // Production resolves the scope from the calling session's project directory;
  // injected callers (tests, single-repo hosts) may pass a fixed manager/reconciler.
  const scopeFor = typeof resolveScopeForSession === "function"
    ? async (toolContext) => {
        const scope = await resolveScopeForSession(sidFor(toolContext))
        // Never provision or clean before the repo's initial reconciliation has
        // finished, so a create cannot be swept by the startup sweep.
        if (scope.ready) await scope.ready
        return {
          projectKey: scope.projectKey,
          repoRoot: scope.repoRoot,
          worktreeManager: scope.worktrees ?? scope.worktreeManager,
          worktreeReconciler: scope.reconciler ?? scope.worktreeReconciler,
        }
      }
    : async () => ({ projectKey, repoRoot: undefined, worktreeManager, worktreeReconciler })

  const keyFor = (scope, name) => teamRecordKey(scope.projectKey, name)
  const sidFor = (toolContext) => (typeof toolContext?.sessionID === "string" && toolContext.sessionID) || getSessionID()

  const sessionList = async (scope) => {
    if (typeof storage.scan !== "function") return []
    const result = await storage.scan({ prefix: teamRecordsPrefix(scope.projectKey) })
    return (result?.entries ?? []).map((entry) => entry.value).filter((value) => value && typeof value === "object")
  }
  const readTeam = async (key, name) => {
    const team = await storage.get(key)
    if (!team || typeof team !== "object") throw new Error(`Team \"${name}\" was not found`)
    return team
  }

  async function createTeamRun(scope, name, input, toolContext) {
    const declared = normalizeMembers(input)
    if (scope.worktreeReconciler) {
      try { await scope.worktreeReconciler.record({ teamName: name, members: [], reason: "create-in-progress" }) } catch (recordError) { log(`[oh-my-rigel] team worktree journal record failed: ${recordError instanceof Error ? recordError.message : String(recordError)}`) }
    }
    const provisioned = scope.worktreeManager
      ? await scope.worktreeManager.provision({ teamName: name, members: declared })
      : []
    const members = declared.map((member) => {
      const patch = provisioned.find((entry) => entry.name === member.name)
      return patch ? { ...member, worktreePath: patch.worktreePath, worktreeBranch: patch.worktreeBranch } : member
    })
    const pending = { name, projectKey: scope.projectKey, repoRoot: scope.repoRoot, leaderSessionID: sidFor(toolContext), status: "binding", bindingAt: Date.now(), members, messages: [], tasks: [] }
    await storage.set(keyFor(scope, name), pending)
    try {
      if (scope.worktreeManager) await scope.worktreeManager.bindSessions({ members })
    } catch (error) {
      if (scope.worktreeReconciler) {
        try { await scope.worktreeReconciler.runPending({ teamName: name, members, reason: "bind-failed" }) } catch (cleanupError) { log(`[oh-my-rigel] team worktree rollback cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`) }
      } else if (scope.worktreeManager) {
        try { await scope.worktreeManager.cleanup({ members }) } catch (cleanupError) { log(`[oh-my-rigel] team worktree cleanup failed on bind rollback: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`) }
      }
      if (typeof storage.remove === "function") await storage.remove(keyFor(scope, name))
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (scope.worktreeReconciler) { try { await scope.worktreeReconciler.clear({ teamName: name }) } catch { /* journal cleared best-effort */ } }
    const team = { ...pending, status: "active" }
    await storage.set(keyFor(scope, name), team)
    return team
  }

  return {
    team_create: definition("team_create", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input)
      if (await storage.get(keyFor(scope, name))) throw new Error(`Team \"${name}\" already exists`)
      scope.worktreeReconciler?.beginCreate(name)
      try {
        return await createTeamRun(scope, name, input, toolContext)
      } finally {
        scope.worktreeReconciler?.endCreate(name)
      }
    }),
    team_delete: definition("team_delete", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input)
      if (typeof storage.remove !== "function") throw new Error("V2 storage remove is unavailable")
      const team = await storage.get(keyFor(scope, name))
      if (team) {
        if (scope.worktreeReconciler) {
          await scope.worktreeReconciler.record({ teamName: name, members: team.members, reason: "delete" })
          await scope.worktreeReconciler.runPending({ teamName: name, members: team.members, reason: "delete" })
        } else if (scope.worktreeManager) {
          try { await scope.worktreeManager.cleanup({ members: team.members }) } catch (error) { log(`[oh-my-rigel] team worktree cleanup failed on delete: ${error instanceof Error ? error.message : String(error)}`) }
        }
      }
      await storage.remove(keyFor(scope, name))
      return { name, deleted: true }
    }),
    team_shutdown_request: definition("team_shutdown_request", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const next = { ...team, status: "shutdown-requested" }; await storage.set(keyFor(scope, name), next); return next
    }),
    team_approve_shutdown: definition("team_approve_shutdown", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const next = { ...team, status: "shutdown-approved" }; await storage.set(keyFor(scope, name), next)
      if (scope.worktreeReconciler) {
        await scope.worktreeReconciler.record({ teamName: name, members: next.members, reason: "shutdown-approved" })
        void scope.worktreeReconciler.runPending({ teamName: name, members: next.members, reason: "shutdown-approved" })
      } else if (scope.worktreeManager) {
        scope.worktreeManager.cleanupNonBlocking({ members: next.members })
      }
      return next
    }),
    team_reject_shutdown: definition("team_reject_shutdown", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const next = { ...team, status: "active" }; await storage.set(keyFor(scope, name), next); return next
    }),
    team_send_message: definition("team_send_message", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const text = typeof input.message === "string" ? input.message : ""
      if (!text) throw new Error("message is required")
      const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : undefined
      if (to !== undefined && !(team.members ?? []).some((member) => member.name === to) && to !== "lead") {
        throw new Error(`member \"${to}\" is not part of team \"${name}\"`)
      }
      const message = { id: randomUUID(), from: sidFor(toolContext), to, text, read: false }
      const next = { ...team, messages: [...(team.messages ?? []), message] }; await storage.set(keyFor(scope, name), next)
      return { messageId: message.id, to: message.to, team: next }
    }),
    team_task_create: definition("team_task_create", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const task = { id: randomUUID(), ...(input.task && typeof input.task === "object" ? input.task : {}), status: "open" }
      const next = { ...team, tasks: [...(team.tasks ?? []), task] }; await storage.set(keyFor(scope, name), next); return task
    }),
    team_task_list: definition("team_task_list", async (input, toolContext) => {
      const scope = await scopeFor(toolContext); const name = teamName(input)
      return (await readTeam(keyFor(scope, name), name)).tasks ?? []
    }),
    team_task_update: definition("team_task_update", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name); const task = input.task
      if (!task || typeof task !== "object" || typeof task.id !== "string") throw new Error("task.id is required")
      const tasks = (team.tasks ?? []).map((entry) => entry.id === task.id ? { ...entry, ...task } : entry)
      const next = { ...team, tasks }; await storage.set(keyFor(scope, name), next); return tasks.find((entry) => entry.id === task.id)
    }),
    team_task_get: definition("team_task_get", async (input, toolContext) => {
      const scope = await scopeFor(toolContext); const name = teamName(input)
      return (await readTeam(keyFor(scope, name), name)).tasks ?? []
    }),
    team_status: definition("team_status", async (input, toolContext) => {
      const scope = await scopeFor(toolContext); const name = teamName(input)
      return await readTeam(keyFor(scope, name), name)
    }),
    team_list: definition("team_list", async (_input, toolContext) => {
      const scope = await scopeFor(toolContext)
      return await sessionList(scope)
    }),
  }
}
