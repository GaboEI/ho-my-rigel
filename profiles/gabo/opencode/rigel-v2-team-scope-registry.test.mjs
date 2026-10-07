import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { canonicalRepoRoot, createTeamScopeRegistry } from "./rigel-v2-team-scope-registry.mjs"
import { createTeamTools } from "./tools/team.tools.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"

const TOOLS_SOURCE = fileURLToPath(new URL("./tools/team.tools.mjs", import.meta.url))

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

const identityRealpath = (value) => value

function repoRunner(toplevel) {
  return async (args) => {
    if (args[0] === "-C" && args[2] === "rev-parse") return { code: 0, stdout: `${toplevel}\n`, stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
}

describe("canonical repo root and scope cache", () => {
  test("#given a repo, a subdirectory and a symlinked path #when resolving scope #then all share one project key and manager", async () => {
    const storage = memoryStorage()
    const registry = createTeamScopeRegistry({ storage, runGit: repoRunner("/canonical/repo"), realpath: identityRealpath })
    const root = await registry.forRepoRoot("/canonical/repo")
    const sub = await registry.forRepoRoot("/canonical/repo/packages/deep")
    const link = await registry.forRepoRoot("/canonical/repo-link")
    expect(sub).toBe(root)
    expect(link).toBe(root)
    expect(sub.projectKey).toBe(root.projectKey)
    expect(sub.worktrees).toBe(root.worktrees)
    await root.ready
  })

  test("#given two different repos #when resolving scope #then their keys and managers stay separate", async () => {
    const storage = memoryStorage()
    let toplevel = "/repo-a"
    const runGit = async (args) => (args[0] === "-C" && args[2] === "rev-parse" ? { code: 0, stdout: `${toplevel}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" })
    const registry = createTeamScopeRegistry({ storage, runGit, realpath: identityRealpath })
    const a = await registry.forRepoRoot("/repo-a")
    toplevel = "/repo-b"
    const b = await registry.forRepoRoot("/repo-b")
    expect(a.projectKey).not.toBe(b.projectKey)
    expect(a.worktrees).not.toBe(b.worktrees)
    expect(a.repoRoot).toBe("/repo-a")
    expect(b.repoRoot).toBe("/repo-b")
  })

  test("#given a symlinked path with no git #when resolving scope #then the real path is canonicalized", async () => {
    const storage = memoryStorage()
    const runGit = async () => ({ code: 128, stdout: "", stderr: "not a repo" })
    const realpath = (value) => (value === "/link" ? "/real" : value)
    const registry = createTeamScopeRegistry({ storage, runGit, realpath })
    const viaLink = await registry.forRepoRoot("/link")
    const viaReal = await registry.forRepoRoot("/real")
    expect(viaLink).toBe(viaReal)
    expect(viaLink.repoRoot).toBe("/real")
  })

  test("#given a non-repository path #when canonicalizing #then it falls back to the directory", async () => {
    const runGit = async () => ({ code: 128, stdout: "", stderr: "nope" })
    expect(await canonicalRepoRoot("/tmp/x", { runGit, realpath: identityRealpath })).toBe("/tmp/x")
  })
})

describe("scope.ready gates mutating operations", () => {
  test("#given the repo's initial reconcile is still running #when team_create runs #then it does not touch git until ready resolves", async () => {
    const storage = memoryStorage()
    let resolveReady
    let readyResolved = false
    const ready = new Promise((resolve) => { resolveReady = () => { readyResolved = true; resolve() } })
    let provisioned = false
    const worktrees = {
      async provision() {
        if (!readyResolved) throw new Error("provision ran before the initial reconcile was ready")
        provisioned = true
        return []
      },
      async bindSessions() {},
      async cleanup() { return { removed: [], errors: [] } },
    }
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead",
      resolveScopeForSession: async () => ({ projectKey: "p-a", repoRoot: "/repo", ready, worktrees }),
    })
    const creating = tools.team_create.execute({ team_name: "t", members: ["m"] })
    // Provision must NOT have run while ready is pending.
    expect(provisioned).toBe(false)
    resolveReady()
    await creating
    expect(provisioned).toBe(true)
  })

  test("#given the repo's initial reconcile rejects #when team_create runs #then it fails closed with zero git, provision or storage mutation", async () => {
    const storage = memoryStorage()
    let rejectReady
    const ready = new Promise((_resolve, reject) => { rejectReady = reject })
    let provisioned = false
    const worktrees = {
      async provision() { provisioned = true; return [] },
      async bindSessions() {},
      async cleanup() { return { removed: [], errors: [] } },
    }
    const tools = createTeamTools({ storage, getSessionID: () => "lead", resolveScopeForSession: async () => ({ projectKey: "p-a", repoRoot: "/repo", ready, worktrees }) })
    const creating = tools.team_create.execute({ team_name: "t", members: ["m"] })
    rejectReady(new Error("reconcile boom"))
    await expect(creating).rejects.toThrow("reconcile boom")
    expect(provisioned).toBe(false)
    expect(storage.map.has("rigel-v2/team/p-a/t")).toBe(false)
  })

  test("#given the initial reconcile failed #when it is retried and succeeds #then a controlled retry recovers", async () => {
    const storage = memoryStorage()
    let failScan = true
    const scanStorage = {
      map: new Map(),
      async get(key) { return this.map.get(key) },
      async set(key, value) { this.map.set(key, value) },
      async remove(key) { this.map.delete(key) },
      async scan({ prefix = "" } = {}) {
        if (failScan && prefix.startsWith("rigel-v2/team")) throw new Error("scan boom")
        return { entries: [] }
      },
    }
    const registry = createTeamScopeRegistry({ storage: scanStorage, runGit: repoRunner("/r"), realpath: identityRealpath })
    const scope = await registry.forRepoRoot("/r")
    await expect(scope.ready).rejects.toThrow("scan boom")
    // The failed scope is dropped, so the next access builds a fresh one.
    failScan = false
    const retried = await registry.forRepoRoot("/r")
    expect(retried).not.toBe(scope)
    await retried.ready
    expect(retried.projectKey).toBe(scope.projectKey)
  })
})

describe("ready gating named-RED mutation", () => {
  test("#given the real tools #when the ready await is dropped #then create provisions before the initial reconcile and the contract turns RED", async () => {
    // The mutant copy must sit in the tools/ directory so its relative import of
    // the scope module resolves.
    const target = path.join(path.dirname(TOOLS_SOURCE), ".t26-tools-copy.mjs")
    fs.copyFileSync(TOOLS_SOURCE, target)
    const before = createHash("sha256").update(fs.readFileSync(target)).digest("hex")
    try {
      const receipt = await runMutation({
        file: target,
        mutate: (source) => source.replace("        if (scope.ready) await scope.ready\n", ""),
        contract: {
          name: "create waits for the repo's initial reconcile",
          run: async ({ load }) => {
            const module = await load()
            const storage = memoryStorage()
            let provisioned = false
            const ready = new Promise(() => {}) // never resolves: models a running reconcile
            const worktrees = {
              async provision() { provisioned = true; return [] },
              async bindSessions() {},
              async cleanup() { return { removed: [], errors: [] } },
            }
            const tools = module.createTeamTools({ storage, getSessionID: () => "lead", resolveScopeForSession: async () => ({ projectKey: "p-a", repoRoot: "/repo", ready, worktrees }) })
            void tools.team_create.execute({ team_name: "t", members: ["m"] }).catch(() => {})
            for (let i = 0; i < 25; i += 1) await Promise.resolve()
            if (provisioned) throw new Error("expected create to wait for the initial reconcile before provisioning")
          },
        },
      })
      expect(receipt.red).toBe(true)
      expect(receipt.beforeHash).toBe(receipt.afterHash)
      expect(createHash("sha256").update(fs.readFileSync(target)).digest("hex")).toBe(before)
    } finally {
      fs.rmSync(target, { force: true })
    }
  })
})
