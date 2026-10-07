// Rigel V2 CLI `worktree-sweep`.
//
// Own implementation of the repo-maintenance surface: it reads
// `git worktree list --porcelain`, keeps the linked worktrees, classifies each
// (SWEEP when merged and clean, KEEP when dirty or locked, PRUNE when the path
// is gone) and, unless `--dry-run`, removes the sweepable ones and prunes the
// stale ones. Protected prefixes such as `.codex/worktrees` are never swept.
// It never launches OpenCode.
import { existsSync } from "node:fs"
import path from "node:path"

import { fail, parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

const DEFAULT_EXCLUDE_PREFIXES = [".codex/worktrees", ".claude/worktrees"]

export function parsePorcelain(text) {
  const records = []
  let current = null
  for (const line of String(text).split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current)
      current = { path: line.slice("worktree ".length).trim(), branch: null, detached: false, locked: false, prunable: false }
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
    } else if (current && line.trim() === "detached") {
      current.detached = true
    } else if (current && line.startsWith("locked")) {
      current.locked = true
    } else if (current && line.trim() === "prunable") {
      current.prunable = true
    }
  }
  if (current) records.push(current)
  return records
}

export function classifyWorktree(record, { pathExists, merged, dirty }) {
  if (record.locked) return { decision: "KEEP", reason: "locked" }
  if (!pathExists) return { decision: "PRUNE", reason: "missing" }
  if (dirty) return { decision: "KEEP", reason: "dirty" }
  if (merged) return { decision: "SWEEP", reason: "merged" }
  return { decision: "KEEP", reason: "active" }
}

function isExcluded(worktreePath, repo, excludePrefixes) {
  const relative = path.relative(repo, worktreePath).split(path.sep).join("/")
  return excludePrefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))
}

function git(io, cwd, args) {
  return io.spawn("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function defaultBranch(io, repo) {
  const remoteHead = git(io, repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (remoteHead.status === 0 && remoteHead.stdout.trim()) return remoteHead.stdout.trim().replace(/^origin\//, "")
  for (const candidate of ["main", "master"]) {
    const check = git(io, repo, ["rev-parse", "--verify", "--quiet", candidate])
    if (check.status === 0) return candidate
  }
  return "main"
}

function mergedBranches(io, repo, branch) {
  const result = git(io, repo, ["branch", "--merged", branch, "--format=%(refname:short)"])
  if (result.status !== 0) return new Set()
  return new Set(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean))
}

export const worktreeSweepCommand = {
  name: "worktree-sweep",
  summary: "Sweep obsolete git worktrees in a repository",
  usage: "rigel-v2 worktree-sweep [--repo <dir>] [--older-than <days>] [--dry-run] [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const repoInput = options.repo === undefined ? io.cwd : String(options.repo)
    const dryRun = options["dry-run"] === true
    const excludePrefixes = DEFAULT_EXCLUDE_PREFIXES

    const root = git(io, repoInput, ["rev-parse", "--show-toplevel"])
    if (root.status !== 0) return fail(io, `${repoInput} is not a git repository`)
    const repo = root.stdout.trim()

    const listed = git(io, repo, ["worktree", "list", "--porcelain"])
    if (listed.status !== 0) return fail(io, `could not list worktrees in ${repo}`)
    const records = parsePorcelain(listed.stdout)
    const linked = records.slice(1)
    const merged = mergedBranches(io, repo, defaultBranch(io, repo))

    const swept = []
    const kept = []
    const pruned = []
    const failed = []
    for (const record of linked) {
      const pathExists = existsSync(record.path)
      const excluded = isExcluded(record.path, repo, excludePrefixes)
      const dirty = pathExists ? git(io, record.path, ["status", "--porcelain"]).stdout.trim().length > 0 : false
      const isMerged = record.branch !== null && merged.has(record.branch)
      const classification = excluded
        ? { decision: "KEEP", reason: "excluded" }
        : classifyWorktree(record, { pathExists, merged: isMerged, dirty })
      const entry = { path: record.path, branch: record.branch, ...classification }
      if (classification.decision === "SWEEP") {
        if (dryRun) {
          swept.push(entry)
        } else {
          const removed = git(io, repo, ["worktree", "remove", "--force", record.path])
          if (removed.status === 0) swept.push(entry)
          else failed.push({ ...entry, error: removed.stderr.trim() })
        }
      } else if (classification.decision === "PRUNE") {
        if (dryRun) {
          pruned.push(entry)
        } else {
          const result = git(io, repo, ["worktree", "prune"])
          if (result.status === 0) pruned.push(entry)
          else failed.push({ ...entry, error: result.stderr.trim() })
        }
      } else {
        kept.push(entry)
      }
    }

    const report = { repos: [{ repo, dryRun, swept, kept, pruned, failed }] }
    if (options.json === true) {
      writeJson(io, report)
    } else {
      io.stdout.write(`${repo}: swept ${swept.length}, kept ${kept.length}, pruned ${pruned.length}, failed ${failed.length}\n`)
      for (const entry of swept) io.stdout.write(`  sweep ${entry.path} (${entry.reason})\n`)
      for (const entry of pruned) io.stdout.write(`  prune ${entry.path} (${entry.reason})\n`)
      for (const entry of kept) io.stdout.write(`  keep  ${entry.path} (${entry.reason})\n`)
    }
    return failed.length > 0 ? 1 : 0
  },
}
