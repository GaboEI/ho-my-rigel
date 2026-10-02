import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createNativeRulesInjector } from "./rigel-v2-native-rules.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-rules-"))
  temporary.push(root)
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.mkdirSync(path.join(root, ".omo", "rules"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "subject.ts"), "export const subject = 1\n")
  return root
}

describe("Rigel native V2 rules injector", () => {
  test("appends a matching project rule to the same V2 read result once", () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "typescript.md"), "---\nglobs:\n  - src/**/*.ts\n---\nUSE_TYPESCRIPT_RULE\n")
    const rules = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const input = { status: "completed", tool: "read", sessionID: "ses_rule", input: { path: "src/subject.ts" }, result: { content: "read output" } }
    expect(rules.after(input)).toBe(true)
    expect(input.result.content).toContain("USE_TYPESCRIPT_RULE")
    expect(rules.after(input)).toBe(false)
  })

  test("honors alwaysApply and ignores a rule outside the current path", () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nALWAYS_RULE\n")
    fs.writeFileSync(path.join(root, ".omo", "rules", "python.md"), "---\nglobs: '**/*.py'\n---\nPYTHON_ONLY\n")
    const rules = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const input = { status: "completed", tool: "read", sessionID: "ses_rule", input: { path: "src/subject.ts" }, result: { content: "read output" } }
    rules.after(input)
    expect(input.result.content).toContain("ALWAYS_RULE")
    expect(input.result.content).not.toContain("PYTHON_ONLY")
  })
})
