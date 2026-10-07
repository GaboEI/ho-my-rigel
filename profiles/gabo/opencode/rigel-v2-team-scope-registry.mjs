/**
 * Per-repo scope registry for team worktrees.
 *
 * The V2 plugin instance is loaded once for a location, but a session (and its
 * team) belongs to the repo of that session's working directory. Keying teams and
 * the journal by the plugin instance's location therefore collides across repos
 * observed by one plugin.
 *
 * This registry resolves a directory to its CANONICAL repo root
 * (`git rev-parse --show-toplevel` then `realpath`), so a session in a
 * subdirectory or reached through a symlink of the same repo resolves to the same
 * project key and the same manager (and `.omo` is created at the repo root, never
 * in a subdirectory). It caches one worktree manager + one reconciler per
 * canonical root.
 *
 * Each scope exposes `ready`: the promise of its initial reconciliation. Mutating
 * operations MUST await `ready` before they provision or clean, so a create can
 * never race the initial sweep (the race that let a fresh create be swept).
 */

import { realpathSync } from "node:fs"
import { createGitWorktreeRunner, createTeamWorktreeManager } from "./rigel-v2-team-worktrees.mjs"
import { createTeamWorktreeReconciler } from "./rigel-v2-team-worktree-reconcile.mjs"
import { resolveProjectKey } from "./rigel-v2-team-project-scope.mjs"

export async function canonicalRepoRoot(directory, { runGit, realpath = realpathSync } = {}) {
  if (typeof directory !== "string" || !directory.trim()) throw new Error("team scope requires a directory")
  let root = directory
  try {
    const result = await runGit(["-C", directory, "rev-parse", "--show-toplevel"])
    if (result?.code === 0 && typeof result.stdout === "string" && result.stdout.trim()) root = result.stdout.trim()
  } catch {
    // Not a git work tree: fall back to the directory itself.
  }
  try {
    return realpath(root)
  } catch {
    return root
  }
}

export function createTeamScopeRegistry({ storage, runGit = createGitWorktreeRunner(), realpath, log = () => {}, bindSession, now, bindingStaleMs } = {}) {
  if (!storage || typeof storage.get !== "function") throw new Error("team scope registry requires V2 storage")
  const byRoot = new Map()
  const inflight = new Map()

  async function forRepoRoot(directory) {
    const repoRoot = await canonicalRepoRoot(directory, { runGit, realpath })
    const cached = byRoot.get(repoRoot)
    if (cached) return cached
    const pending = inflight.get(repoRoot)
    if (pending) return pending
    const promise = (async () => {
      const projectKey = resolveProjectKey({ repoRoot })
      const worktrees = createTeamWorktreeManager({ repoRoot, runGit, log, bindSession })
      const reconciler = createTeamWorktreeReconciler({ storage, worktrees, projectKey, repoRoot, log, now, bindingStaleMs })
      const scope = { projectKey, repoRoot, worktrees, reconciler, ready: undefined }
      // Start the initial reconcile now. It FAILS CLOSED: a rejected reconcile
      // still rejects `ready` (and drops the scope so the next access retries),
      // so a mutating caller never proceeds on an inconsistent sweep/journal.
      const ready = reconciler.reconcile().then(
        () => undefined,
        (error) => {
          log(`[oh-my-rigel] team worktree reconciliation failed for ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`)
          byRoot.delete(repoRoot)
          throw error
        },
      )
      ready.catch(() => {}) // a read-only caller that ignores `ready` must not crash the process
      scope.ready = ready
      byRoot.set(repoRoot, scope)
      return scope
    })().finally(() => inflight.delete(repoRoot))
    inflight.set(repoRoot, promise)
    return promise
  }

  return {
    forRepoRoot,
    resolveCanonicalRoot: (directory) => canonicalRepoRoot(directory, { runGit, realpath }),
  }
}
