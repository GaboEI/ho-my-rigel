import { describe, expect, test } from "bun:test"
import { createTeamTools } from "./team.tools.mjs"
import { createTeamWorktreeManager } from "../rigel-v2-team-worktrees.mjs"

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

const noRemoveDir = async () => {}

function recordingRunner(handler) {
  const calls = []
  const runGit = async (args) => {
    calls.push(args.join(" "))
    if (handler) return handler(args)
    if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { calls, runGit }
}

function buildTools({ storage = memoryStorage(), runGit, bindSession, reconciler, setup } = {}) {
  const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {}, bindSession })
  const spied = setup ? setup(manager) : manager
  const tools = createTeamTools({ storage, getSessionID: () => "lead-session", worktreeManager: spied, worktreeReconciler: reconciler })
  return { storage, tools, manager: spied }
}

function reconcilerStub() {
  const calls = []
  return {
    calls,
    async record({ teamName, reason }) { calls.push(["record", teamName, reason]) },
    async clear({ teamName }) { calls.push(["clear", teamName]) },
    async runPending({ teamName, reason }) { calls.push(["runPending", teamName, reason]); return { cleaned: true } },
    beginCreate() {},
    endCreate() {},
    async reconcile() { return {} },
  }
}

describe("native V2 team tools and per-member worktrees", () => {
  test("#given a team of two members #when team_create runs #then each member gets a distinct worktree recorded in the team and its session is bound", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    const bound = []
    const { storage, tools } = buildTools({ runGit, bindSession: async ({ sessionID, directory }) => { bound.push({ sessionID, directory }) } })
    // when
    const team = await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout", sessionID: "ses_1" }, { name: "digger", sessionID: "ses_2" }] })
    // then
    const paths = team.members.map((member) => member.worktreePath)
    expect(team.members.every((member) => typeof member.worktreePath === "string" && member.worktreePath.length > 0)).toBe(true)
    expect(new Set(paths).size).toBe(2)
    expect(team.members[0].worktreeBranch).toBe("rigel-team/builders/scout")
    expect(calls.filter((line) => line.includes("worktree add -b"))).toHaveLength(2)
    expect(bound).toHaveLength(2)
    const persisted = await storage.get("rigel-v2/team/p-default/builders")
    expect(persisted.members.map((member) => member.worktreePath)).toEqual(paths)
  })

  test("#given no worktree manager #when team_create runs #then the declared members are stored unchanged (no worktree side effect)", async () => {
    // given
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session" })
    // when
    const team = await tools.team_create.execute({ team_name: "plain", members: ["scout"] })
    // then
    expect(team.members[0].worktreePath).toBeUndefined()
  })

  test("#given worktree provisioning fails #when team_create runs #then it rejects and persists no team record", async () => {
    // given
    const { runGit } = recordingRunner((args) => {
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
      if (args.includes("add")) return { code: 128, stdout: "", stderr: "add failed" }
      return { code: 0, stdout: "", stderr: "" }
    })
    const { storage, tools } = buildTools({ runGit })
    // when / then
    await expect(tools.team_create.execute({ team_name: "broken", members: [{ name: "scout" }] })).rejects.toThrow("add failed")
    expect(await storage.get("rigel-v2/team/p-default/broken")).toBeUndefined()
  })

  test("#given an active team with worktrees #when team_delete runs #then every worktree and branch is removed and the record is dropped", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    const { storage, tools } = buildTools({ runGit })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }, { name: "digger" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "builders" })
    // then
    expect(result).toEqual({ name: "builders", deleted: true })
    expect(calls.filter((line) => line.includes("worktree remove --force"))).toHaveLength(2)
    expect(calls.filter((line) => line.includes("branch -D rigel-team/builders/"))).toHaveLength(2)
    expect(await storage.get("rigel-v2/team/p-default/builders")).toBeUndefined()
  })

  test("#given an active team with worktrees #when team_approve_shutdown runs #then it schedules non-blocking cleanup without waiting", async () => {
    // given
    const { runGit } = recordingRunner()
    let scheduled = 0
    const { tools } = buildTools({
      runGit,
      setup: (manager) => ({
        ...manager,
        cleanupNonBlocking: (args) => { scheduled += 1; return manager.cleanupNonBlocking(args) },
      }),
    })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    const next = await tools.team_approve_shutdown.execute({ team_name: "builders" })
    // then
    expect(next.status).toBe("shutdown-approved")
    expect(scheduled).toBe(1)
  })

  test("#given cleanup always fails #when team_approve_shutdown runs #then the shutdown still resolves (cleanup never blocks)", async () => {
    // given: creation succeeds, but every cleanup git call throws
    const runGit = async (args) => {
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
      if (args.includes("add")) return { code: 0, stdout: "", stderr: "" }
      throw new Error("git exploded")
    }
    const { tools } = buildTools({ runGit })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    const next = await tools.team_approve_shutdown.execute({ team_name: "builders" })
    // then
    expect(next.status).toBe("shutdown-approved")
  })

  test("#given a member session that cannot be bound #when team_create runs #then it rolls back transactionally: no team, worktrees reclaimed, journal recorded", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    const reconciler = reconcilerStub()
    const { storage, tools } = buildTools({ runGit, reconciler, bindSession: async ({ sessionID }) => { if (sessionID === "ses_bad") throw new Error("move failed") } })
    // when / then
    await expect(tools.team_create.execute({ team_name: "builders", members: [{ name: "scout", sessionID: "ses_bad" }] })).rejects.toThrow("bind failed")
    expect(await storage.get("rigel-v2/team/p-default/builders")).toBeUndefined()
    expect(reconciler.calls).toContainEqual(["runPending", "builders", "bind-failed"])
  })

  test("#given a reconciler #when team_approve_shutdown runs #then the cleanup is journaled durably before it runs", async () => {
    // given
    const reconciler = reconcilerStub()
    const { tools } = buildTools({ runGit: recordingRunner().runGit, reconciler })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    await tools.team_approve_shutdown.execute({ team_name: "builders" })
    // then
    const recordIndex = reconciler.calls.findIndex((call) => call[0] === "record" && call[2] === "shutdown-approved")
    const runIndex = reconciler.calls.findIndex((call) => call[0] === "runPending")
    expect(recordIndex).toBeGreaterThanOrEqual(0)
    expect(runIndex).toBeGreaterThan(recordIndex)
  })

  test("#given a reconciler #when team_delete runs #then it journals and runs the cleanup then drops the record", async () => {
    // given
    const reconciler = reconcilerStub()
    const { storage, tools } = buildTools({ runGit: recordingRunner().runGit, reconciler })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    await tools.team_delete.execute({ team_name: "builders" })
    // then
    expect(reconciler.calls).toContainEqual(["record", "builders", "delete"])
    expect(reconciler.calls).toContainEqual(["runPending", "builders", "delete"])
    expect(await storage.get("rigel-v2/team/p-default/builders")).toBeUndefined()
  })
})
