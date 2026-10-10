import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

// Fail-closed artifact-integrity guard: every shipped file under `web/` must be tracked in git, so a
// local-only asset (e.g. one hidden by a global gitignore) can never make the build pass locally but
// fail ENOENT from a clean CI checkout. `dist/` is the gitignored build output and is skipped.

const REPO = fileURLToPath(new URL("../../", import.meta.url))
const WEB = join(REPO, "web")
const SKIP = new Set(["dist", "node_modules"])

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : walk(join(dir, entry.name))
    return [join(dir, entry.name)]
  })
}

function isTracked(repoRelative: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", repoRelative], { cwd: REPO, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

describe("#given the web tree #when compared to the git index #then every shipped file is tracked", () => {
  test("#given every file under web/ (excluding dist) #when checked #then none is untracked", () => {
    // given / when / then
    const files = walk(WEB).map((file) => relative(REPO, file))
    expect(files.length).toBeGreaterThan(0)
    const untracked = files.filter((file) => !isTracked(file))
    expect(untracked).toEqual([])
  })
})
