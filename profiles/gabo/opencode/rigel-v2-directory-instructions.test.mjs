import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createDirectoryInstructionStore } from "./rigel-v2-directory-instructions.mjs"

const temporary = []
afterEach(() => { while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

test("records applicable AGENTS.md rules and README.md context in root-to-leaf order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-directory-rules-"))
  temporary.push(root)
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true })
  fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT_RULE")
  fs.writeFileSync(path.join(root, "README.md"), "ROOT_README")
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "SRC_RULE")
  fs.writeFileSync(path.join(root, "src", "README.md"), "SRC_README")
  fs.writeFileSync(path.join(root, "src", "nested", "file.ts"), "export {}")
  const store = createDirectoryInstructionStore({ directory: root })
  expect(store.recordRead({ tool: "read", sessionID: "ses_1", input: { path: "src/nested/file.ts" } })).toBe(true)
  const injected = store.guidance("ses_1")
  expect(injected).toContain("ROOT_RULE")
  expect(injected).toContain("ROOT_README")
  expect(injected).toContain("SRC_RULE")
  expect(injected).toContain("SRC_README")
  expect(injected.indexOf("ROOT_RULE")).toBeLessThan(injected.indexOf("SRC_RULE"))
  expect(injected.indexOf("ROOT_README")).toBeLessThan(injected.indexOf("SRC_README"))
  expect(injected.indexOf("ROOT_RULE")).toBeLessThan(injected.indexOf("ROOT_README"))
  expect(store.recordRead({ tool: "read", sessionID: "ses_1", input: { path: "../outside.txt" } })).toBe(false)
  expect(store.guidance("ses_1")).not.toContain("outside")
})
