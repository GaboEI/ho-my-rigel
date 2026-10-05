import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"

export function detectWorktree(directory, requested) {
  if (!requested) return { path: undefined, block: "" }
  try {
    const expected = realpathSync(resolve(requested))
    const actual = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: expected, encoding: "utf8", timeout: 5000 }).trim())
    return actual === expected ? { path: actual, block: `\nWorktree Active: ${actual}` } : { path: undefined, block: missingWorktreeBlock(requested) }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { path: undefined, block: missingWorktreeBlock(requested) }
  }
}

export function createPrDeliveryBlock({ makePr, ship }, worktreePath) {
  if (!makePr && !ship) return ""
  const mode = ship ? "Ship: keep working until the PR is merged." : "Make PR: hand off with the PR URL after it opens."
  return `\n${mode}${worktreePath ? "" : " Create a task-owned worktree before implementation."}`
}

function missingWorktreeBlock(path) {
  return `\nWorktree needs setup: git worktree add ${path} <branch>`
}
