import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")
const RUNTIME_SUBDIR = "opencode"
const ENTRY = "rigel-v2-native.mjs"

/**
 * Test-only source-dir override. Default is the real runtime tree; a control
 * run may point it at a disposable copy to drive the real assertions RED
 * without touching the repository. Never set in a normal run.
 */
const SOURCE_DIR = process.env.RIGEL_NATIVE_SOURCE_DIR ? path.resolve(process.env.RIGEL_NATIVE_SOURCE_DIR) : path.join(HERE, RUNTIME_SUBDIR)

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-discovery-"))
  temporary.push(root)
  return root
}

/**
 * Local-relative import shapes discoverRuntimeModules() cannot follow. Any of
 * these silently drops the target module from lab staging, so the deployed
 * runtime fails to import it later. Only `from "..."` with double quotes is
 * accepted by the discovery parser.
 */
const FORBIDDEN_RELATIVE_IMPORTS = [
  { form: "single-quoted static import", pattern: /\bfrom\s*'(\.[^'\n]+)'/g },
  { form: "side-effect import", pattern: /\bimport\s*["'](\.[^"'\n]+)["']/g },
  { form: "dynamic import", pattern: /\bimport\s*\(\s*["'`](\.[^"'`\n]+)["'`]\s*\)/g },
]

/** The entry plus every module the parser transitively discovers from it. */
function reachableRuntimeFiles(sourceDir) {
  return [ENTRY, ...discoverRuntimeModules(sourceDir, ENTRY)]
}

/** Every reachable module using a local import shape the parser cannot follow. */
function findForbiddenRelativeImports(sourceDir, files = reachableRuntimeFiles(sourceDir)) {
  const violations = []
  for (const file of files) {
    const absolute = path.join(sourceDir, file)
    if (!fs.existsSync(absolute)) continue
    const text = fs.readFileSync(absolute, "utf8")
    for (const { form, pattern } of FORBIDDEN_RELATIVE_IMPORTS) {
      for (const match of text.matchAll(pattern)) {
        violations.push({ file, form, specifier: match[1] })
      }
    }
  }
  return violations
}

/** Runtime-looking candidates that lab staging would never copy. */
function findUnreachableRuntimeModules(candidates, discovered) {
  const known = new Set(discovered)
  return candidates.filter((file) => file !== ENTRY && !known.has(file)).sort()
}

/**
 * Non-test `rigel-v2-*.mjs` modules in the committed tree. HEAD is the source of
 * truth, not the index, so untracked in-flight modules owned by a parallel task
 * are out of scope until they are wired and committed.
 */
function committedRuntimeModules() {
  const prefix = `profiles/gabo/${RUNTIME_SUBDIR}/`
  const output = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", `profiles/gabo/${RUNTIME_SUBDIR}`], { cwd: REPO_ROOT, encoding: "utf8" })
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.startsWith(prefix) && /^rigel-v2-.*\.mjs$/.test(file.slice(prefix.length)))
    .map((file) => file.slice(prefix.length))
    .filter((file) => !file.endsWith(".test.mjs"))
}

describe("Rigel native runtime module discovery", () => {
  test("#given an entry that imports a nested module #when discovering #then both the entry's deps and nested files are returned", () => {
    const root = workspace()
    fs.mkdirSync(path.join(root, "tools"), { recursive: true })
    fs.writeFileSync(path.join(root, "rigel-v2-native.mjs"), 'import { a } from "./a.mjs"\nimport { b } from "./tools/b.mjs"\n')
    fs.writeFileSync(path.join(root, "a.mjs"), 'import { c } from "./c.mjs"\nexport const a = c\n')
    fs.writeFileSync(path.join(root, "c.mjs"), "export const c = 1\n")
    fs.writeFileSync(path.join(root, "tools/b.mjs"), "export const b = 1\n")
    const found = discoverRuntimeModules(root)
    expect(found).toContain("a.mjs")
    expect(found).toContain("c.mjs")
    expect(found).toContain("tools/b.mjs")
    expect(found).not.toContain("rigel-v2-native.mjs")
  })

  test("#given a broken relative import #when discovering #then the missing target is skipped without throwing", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "rigel-v2-native.mjs"), 'import { missing } from "./missing.mjs"\nimport { p } from "./present.mjs"\n')
    fs.writeFileSync(path.join(root, "present.mjs"), "export const p = 1\n")
    const found = discoverRuntimeModules(root)
    expect(found).toContain("present.mjs")
    expect(found).not.toContain("missing.mjs")
  })
})

describe("Rigel native runtime module staging guard", () => {
  test("#given the native entry's transitive runtime graph #when every reachable module is scanned for local imports #then each uses the double-quoted from form", () => {
    expect(findForbiddenRelativeImports(SOURCE_DIR)).toEqual([])
  })

  test("#given the committed runtime modules #when compared to the native entry's transitive graph #then none is orphaned from lab staging", () => {
    const unreachable = findUnreachableRuntimeModules(committedRuntimeModules(), discoverRuntimeModules(SOURCE_DIR, ENTRY))
    expect(unreachable).toEqual([])
  })

  const FORBIDDEN_FIXTURES = [
    { form: "single-quoted static import", entry: "import { dep } from './dep.mjs'\n" },
    { form: "side-effect import", entry: 'import "./dep.mjs"\n' },
    { form: "dynamic import", entry: 'const dep = await import("./dep.mjs")\n' },
  ]

  for (const { form, entry } of FORBIDDEN_FIXTURES) {
    test(`#given a runtime entry with a ${form} of a local module #when guarding #then it is reported RED`, () => {
      const root = workspace()
      fs.writeFileSync(path.join(root, ENTRY), entry)
      fs.writeFileSync(path.join(root, "dep.mjs"), "export const dep = 1\n")
      expect(findForbiddenRelativeImports(root)).toContainEqual({ file: ENTRY, form, specifier: "./dep.mjs" })
    })
  }

  test("#given a runtime-looking module reachable from nothing #when checking reachability #then it is reported RED", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, ENTRY), 'import { a } from "./reachable.mjs"\n')
    fs.writeFileSync(path.join(root, "reachable.mjs"), "export const a = 1\n")
    fs.writeFileSync(path.join(root, "rigel-v2-orphan.mjs"), "export const orphan = 1\n")
    const unreachable = findUnreachableRuntimeModules(["reachable.mjs", "rigel-v2-orphan.mjs"], discoverRuntimeModules(root, ENTRY))
    expect(unreachable).toEqual(["rigel-v2-orphan.mjs"])
  })
})
