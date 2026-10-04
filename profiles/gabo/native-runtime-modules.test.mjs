import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-discovery-"))
  temporary.push(root)
  return root
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
