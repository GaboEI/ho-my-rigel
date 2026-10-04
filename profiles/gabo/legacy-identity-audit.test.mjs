import { describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

// The retired h-before-o identity is assembled from fragments so this audit
// never contains the literal token it forbids. Every variant (lowercase slug,
// display title, upper snake, title snake) lowercases to one of these needles.
const H = String.fromCharCode(104)
const O = String.fromCharCode(111)
const RETIRED_IDENTITY = [
  `${H}${O}-my-rigel`,
  `${H}${O} my rigel`,
  `${H}${O}_my_rigel`,
  `${H}${O}myrigel`,
]

const TEXT_FILE = /\.(mjs|cjs|js|jsx|ts|tsx|json|jsonc|md|mdx|sh|bash|zsh|yml|yaml|toml|conf|service|txt)$/i

// attic/ is quarantined historical material (the retired V1 bridge); it is
// never activated and is out of scope for the active identity audit.
const EXEMPT_PREFIXES = ["profiles/gabo/attic/"]

const root = path.resolve(import.meta.dir, "../..")

// Active = tracked by git AND present in the worktree. A not-yet-committed
// deletion is not part of the active tree; a clean CI checkout always has every
// tracked file present, so a committed offender is still caught there.
function activeTrackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .filter((file) => existsSync(path.join(root, file)))
}

function findOffenders() {
  const offenders = []
  for (const file of activeTrackedFiles()) {
    const lowerPath = file.toLowerCase()
    for (const needle of RETIRED_IDENTITY) {
      if (lowerPath.includes(needle)) offenders.push(`${file} (path)`)
    }
    if (!TEXT_FILE.test(file)) continue
    const absolute = path.join(root, file)
    if (!existsSync(absolute)) continue
    const lowerContent = readFileSync(absolute, "utf8").toLowerCase()
    for (const needle of RETIRED_IDENTITY) {
      if (lowerContent.includes(needle)) offenders.push(`${file} (content)`)
    }
  }
  return [...new Set(offenders)]
}

describe("active identity audit", () => {
  describe("#given the compatibility layer is retired", () => {
    describe("#when every tracked file is scanned for the wrong h-before-o identity", () => {
      it("#then no active file carries it", () => {
        // given: the tracked tree after the legacy compatibility layer is removed
        // when: each tracked path and text body is lowercased and matched
        const offenders = findOffenders()
        // then: nothing active carries the retired identity
        expect(offenders).toEqual([])
      })
    })
  })
})
