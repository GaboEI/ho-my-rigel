import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createNativeWriteExistingFileGuard } from "./rigel-v2-native-write-guard.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-write-guard-"))
  temporary.push(root)
  fs.writeFileSync(path.join(root, "existing.txt"), "before\n")
  return { root, guard: createNativeWriteExistingFileGuard({ directory: root }) }
}

function event(tool, input, sessionID = "ses_guard") { return { tool, input, sessionID } }

describe("Rigel native V2 write-existing-file guard", () => {
  test("rejects overwriting an existing file before it was read", () => {
    const { guard } = fixture()
    expect(() => guard.before(event("write", { path: "existing.txt", content: "after" }))).toThrow("File already exists")
  })

  test("allows one overwrite after the same session read the file", () => {
    const { guard } = fixture()
    guard.before(event("read", { path: "existing.txt" }))
    expect(() => guard.before(event("write", { path: "existing.txt", content: "after" }))).not.toThrow()
    expect(() => guard.before(event("write", { path: "existing.txt", content: "again" }))).toThrow("File already exists")
  })

  test("allows an explicit overwrite but removes its unsupported argument", () => {
    const { guard } = fixture()
    const input = event("write", { path: "existing.txt", content: "after", overwrite: true })
    expect(() => guard.before(input)).not.toThrow()
    expect(input.input.overwrite).toBeUndefined()
  })
})
