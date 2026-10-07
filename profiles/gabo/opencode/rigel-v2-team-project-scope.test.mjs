import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_PROJECT_KEY,
  cleanupRecordKey,
  isLegacyTeamKey,
  isOwnedByRepo,
  resolveProjectKey,
  sanitizeProjectKey,
  teamRecordKey,
} from "./rigel-v2-team-project-scope.mjs"
import { createTeamTools } from "./tools/team.tools.mjs"
import { createTeamWorktreeReconciler } from "./rigel-v2-team-worktree-reconcile.mjs"
import { createNativeTeamEventHandlers } from "./rigel-v2-team-events.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"

const SCOPE_SOURCE = fileURLToPath(new URL("./rigel-v2-team-project-scope.mjs", import.meta.url))

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan({ prefix = "" } = {}) { return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) } },
  }
}

function worktreeStub() {
  const calls = { cleanup: [], swept: [] }
  return {
    calls,
    async cleanup({ members }) { calls.cleanup.push(members.map((member) => member.name)); return { removed: members.map((member) => member.worktreePath), errors: [] } },
    async sweepOrphans({ referenced }) { calls.swept.push([...referenced]); return { removed: [], errors: [] } },
    resolveTeamDirectory: (name) => `/repo/.omo/team-worktrees/${name}`,
  }
}

const MEMBER = (name) => ({ name, worktreePath: `/repo/.omo/team-worktrees/${name}/m`, worktreeBranch: `rigel-team/${name}/m` })

describe("project scope keys", () => {
  test("#given two projects #when resolving keys #then the same team name never collides", () => {
    const a = resolveProjectKey({ projectId: "proj-a" })
    const b = resolveProjectKey({ projectId: "proj-b" })
    expect(a).not.toBe(b)
    expect(teamRecordKey(a, "shared")).not.toBe(teamRecordKey(b, "shared"))
    expect(teamRecordKey(a, "shared")).toContain(`/${a}/`)
  })

  test("#given no project id #when resolving #then a stable, path-safe hash key is derived from the repo root", () => {
    const one = resolveProjectKey({ repoRoot: "/home/x/repo" })
    const two = resolveProjectKey({ repoRoot: "/home/x/repo" })
    expect(one).toBe(two)
    expect(one).toMatch(/^h-[0-9a-f]{24}$/)
    expect(one).not.toContain("/")
  })

  test("#given an unsafe key value #when sanitizing #then no path separator survives", () => {
    expect(sanitizeProjectKey("a/../../b")).not.toContain("/")
    expect(isLegacyTeamKey("rigel-v2/team/plain")).toBe(true)
    expect(isLegacyTeamKey("rigel-v2/team/p-a/plain")).toBe(false)
  })

  test("#given colliding or special team names #when building keys #then they never collide and stay safe", () => {
    expect(teamRecordKey("p-a", "foo bar")).not.toBe(teamRecordKey("p-a", "foo-bar"))
    expect(teamRecordKey("p-a", "a@b")).not.toBe(teamRecordKey("p-a", "a:b"))
    expect(teamRecordKey("p-a", "caf\u00e9")).toContain("caf%C3%A9")
    expect(teamRecordKey("p-a", "a/b")).toContain("a%2Fb")
    expect(() => teamRecordKey("p-a", "")).toThrow()
    expect(() => teamRecordKey("p-a", "bad\u0000name")).toThrow("control")
  })

  test("#given legacy members #when checking ownership #then only paths under this repo count", () => {
    expect(isOwnedByRepo([{ worktreePath: "/repo/.omo/x" }], "/repo")).toBe(true)
    expect(isOwnedByRepo([{ worktreePath: "/other/.omo/x" }], "/repo")).toBe(false)
    expect(isOwnedByRepo([], "/repo")).toBe(false)
  })
})

describe("project isolation: teams and journal", () => {
  test("#given two projects with the same team name #when each creates it #then both coexist independently", async () => {
    const storage = memoryStorage()
    const a = createTeamTools({ storage, getSessionID: () => "lead-a", projectKey: "p-a" })
    const b = createTeamTools({ storage, getSessionID: () => "lead-b", projectKey: "p-b" })
    await a.team_create.execute({ team_name: "shared", members: ["sa"] })
    await b.team_create.execute({ team_name: "shared", members: ["sb"] })
    expect((await a.team_status.execute({ team_name: "shared" })).leaderSessionID).toBe("lead-a")
    expect((await b.team_status.execute({ team_name: "shared" })).leaderSessionID).toBe("lead-b")
    // deleting A's team never touches B's
    await a.team_delete.execute({ team_name: "shared" })
    expect((await b.team_status.execute({ team_name: "shared" })).leaderSessionID).toBe("lead-b")
    expect(storage.map.has(teamRecordKey("p-a", "shared"))).toBe(false)
    expect(storage.map.has(teamRecordKey("p-b", "shared"))).toBe(true)
  })

  test("#given two projects #when each journals a pending cleanup #then the journals do not overlap", async () => {
    const storage = memoryStorage()
    const ra = createTeamWorktreeReconciler({ storage, worktrees: worktreeStub(), projectKey: "p-a" })
    const rb = createTeamWorktreeReconciler({ storage, worktrees: worktreeStub(), projectKey: "p-b" })
    await ra.record({ teamName: "t", members: [MEMBER("t")] })
    expect(await ra.listPending()).toHaveLength(1)
    expect(await rb.listPending()).toHaveLength(0)
    expect(storage.map.has(cleanupRecordKey("p-a", "t"))).toBe(true)
    expect(storage.map.has(cleanupRecordKey("p-b", "t"))).toBe(false)
  })

  test("#given an orphaned team in each project #when A reconciles #then only A's worktrees are reclaimed", async () => {
    const storage = memoryStorage({
      [teamRecordKey("p-a", "lost")]: { name: "lost", status: "orphaned", members: [MEMBER("lost")], messages: [], tasks: [] },
      [teamRecordKey("p-b", "lost")]: { name: "lost", status: "orphaned", members: [MEMBER("lost")], messages: [], tasks: [] },
    })
    const worktrees = worktreeStub()
    const summary = await createTeamWorktreeReconciler({ storage, worktrees, projectKey: "p-a" }).reconcile()
    expect(summary.cleaned).toEqual(["lost"])
    expect(worktrees.calls.cleanup).toEqual([["lost"]])
    // B's team is untouched
    expect(storage.map.has(teamRecordKey("p-b", "lost"))).toBe(true)
    expect(storage.map.get(teamRecordKey("p-b", "lost")).status).toBe("orphaned")
  })

  test("#given a session in project A #when its leader is deleted #then only A's team is orphaned, never B's", async () => {
    const storage = memoryStorage({
      [teamRecordKey("p-a", "mine")]: { name: "mine", status: "active", leaderSessionID: "ses-a", members: [{ name: "m", sessionID: "ses-a" }], messages: [], tasks: [] },
      [teamRecordKey("p-b", "other")]: { name: "other", status: "active", leaderSessionID: "ses-b", members: [{ name: "m", sessionID: "ses-b" }], messages: [], tasks: [] },
    })
    const handlers = createNativeTeamEventHandlers({ storage, session: {} })
    await handlers[3]({ type: "session.deleted", sessionID: "ses-a" })
    expect(storage.map.get(teamRecordKey("p-a", "mine")).status).toBe("orphaned")
    expect(storage.map.get(teamRecordKey("p-b", "other")).status).toBe("active")
  })

  test("#given a legacy record owned by this repo and one owned by another #when reconciling #then only the owned one is migrated", async () => {
    const storage = memoryStorage({
      "rigel-v2/team/legacy-owned": { name: "legacy-owned", status: "active", members: [{ name: "m", worktreePath: "/repo/.omo/team-worktrees/legacy-owned/m" }], messages: [], tasks: [] },
      "rigel-v2/team/legacy-foreign": { name: "legacy-foreign", status: "active", members: [{ name: "m", worktreePath: "/other/repo/.omo/team-worktrees/legacy-foreign/m" }], messages: [], tasks: [] },
    })
    const summary = await createTeamWorktreeReconciler({ storage, worktrees: worktreeStub(), projectKey: "p-a", repoRoot: "/repo" }).reconcile()
    expect(summary.migrated).toContain("legacy-owned")
    expect(storage.map.has(teamRecordKey("p-a", "legacy-owned"))).toBe(true)
    expect(storage.map.has("rigel-v2/team/legacy-owned")).toBe(false)
    // the foreign record is never adopted or deleted
    expect(storage.map.has("rigel-v2/team/legacy-foreign")).toBe(true)
    expect(storage.map.has(teamRecordKey("p-a", "legacy-foreign"))).toBe(false)
  })

  test("#given the tools called without a project key #when creating a team #then the default scope is used", async () => {
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead" })
    await tools.team_create.execute({ team_name: "t", members: ["m"] })
    expect(storage.map.has(teamRecordKey(DEFAULT_PROJECT_KEY, "t"))).toBe(true)
  })
})

describe("project scope named-RED mutation", () => {
  test("#given the real scope module #when the project key is dropped from team keys #then the isolation contract turns RED and the source is restored", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t26-scope-"))
    const target = path.join(dir, "rigel-v2-team-project-scope.mjs")
    fs.copyFileSync(SCOPE_SOURCE, target)
    const before = createHash("sha256").update(fs.readFileSync(target)).digest("hex")

    try {
      const receipt = await runMutation({
        file: target,
        mutate: (source) => source.replace(
          'return `${TEAM_RECORD_ROOT}${sanitizeProjectKey(projectKey)}/${encodeNameSegment(name, "team name")}`',
          'return `${TEAM_RECORD_ROOT}${encodeNameSegment(name, "team name")}`',
        ),
        contract: {
          name: "team keys are namespaced by project",
          run: async ({ load }) => {
            const module = await load()
            const a = module.teamRecordKey("p-a", "shared")
            const b = module.teamRecordKey("p-b", "shared")
            if (a === b) throw new Error("expected distinct project-scoped team keys")
          },
        },
      })
      expect(receipt.red).toBe(true)
      expect(receipt.beforeHash).toBe(receipt.afterHash)
      expect(createHash("sha256").update(fs.readFileSync(target)).digest("hex")).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
