/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Cross-package portability invariant. The skill and command surfaces shipped from
// `.agents/` and `.opencode/` are user-facing, portable artifacts: a machine-local
// absolute home path baked into one of them leaks the maintainer's machine and breaks
// portability. This is the same architecture class as `markdown-link-audit` (no
// machine-local paths in committed markdown), widened to every shipped skill/command
// file regardless of extension, because skills also ship `.sh`/`.mjs`/`.py`/`.json`.
//
// Contract guarded: shipped `.agents/**` and `.opencode/**` files carry no personal home
// path (`/home/<user>`, `/Users/<user>`, `C:\Users\<user>`).
const WORKSPACE_ROOT = resolve(import.meta.dir, "..")
const PORTABLE_SURFACE_DIRS = [".agents", ".opencode"]
const PERSONAL_PATH_RE = /(?:^|[\s(`'"=:,])(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)(?:[\\/]|$)/

function collectShippedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", ...PORTABLE_SURFACE_DIRS], {
    cwd: WORKSPACE_ROOT,
    stdout: "pipe",
  })
  expect(result.exitCode).toBe(0)
  return result.stdout
    .toString("utf-8")
    .split("\0")
    .filter(Boolean)
    .map((filePath) => resolve(WORKSPACE_ROOT, filePath))
}

function findPersonalPathLines(text: string): number[] {
  return text.split("\n").flatMap((line, index) => (PERSONAL_PATH_RE.test(line) ? [index + 1] : []))
}

describe("shipped skill/command personal-path audit", () => {
  test("#given a machine-local home path #when detected #then posix and windows home paths are flagged", () => {
    expect(findPersonalPathLines("see /home/exampleuser/project and /Users/exampleuser/x")).toEqual([1])
    expect(findPersonalPathLines("C:\\Users\\exampleuser\\project")).toEqual([1])
    expect(findPersonalPathLines("plain relative ./profiles/gabo and $HOME/.config")).toEqual([])
    expect(findPersonalPathLines("url https://example.com/home/exampleuser/x")).toEqual([])
    expect(findPersonalPathLines("example.com/home/exampleuser")).toEqual([])
  })

  test("#given tracked .agents and .opencode surfaces #when scanned #then no machine-local home path is present", () => {
    const offenders = collectShippedFiles().flatMap((filePath) => {
      const text = readFileSync(filePath, "utf-8")
      if (text.includes("\0")) return []
      return findPersonalPathLines(text).map((line) => `${filePath.slice(WORKSPACE_ROOT.length + 1)}:${line}`)
    })
    expect(offenders.sort()).toEqual([])
  })
})
