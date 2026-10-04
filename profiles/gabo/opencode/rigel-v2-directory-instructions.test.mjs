import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DIRECTORY_AGENTS_MARKER,
  createDirectoryInstructionStore,
  isDirectoryInstructionMessage,
} from "./rigel-v2-directory-instructions.mjs"

const temporary = []
afterEach(() => { while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(root)
  return root
}

function readEvent(filePath, sessionID, content = "read output") {
  return { status: "completed", tool: "read", sessionID, input: { path: filePath }, result: { content } }
}

test("appends the walk-up context to the read result, root README in and root AGENTS.md out", () => {
  // given a workspace whose root, src and nested dirs carry AGENTS.md and README.md
  const root = makeRoot("rigel-directory-rules-")
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true })
  fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT_RULE")
  fs.writeFileSync(path.join(root, "README.md"), "ROOT_README")
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "SRC_RULE")
  fs.writeFileSync(path.join(root, "src", "README.md"), "SRC_README")
  fs.writeFileSync(path.join(root, "src", "nested", "AGENTS.md"), "NESTED_RULE")
  fs.writeFileSync(path.join(root, "src", "nested", "file.ts"), "export {}")
  const store = createDirectoryInstructionStore({ directory: root })
  const event = readEvent("src/nested/file.ts", "ses_1")

  // when the nested source file is read
  const appended = store.after(event)

  // then the same read result carries the envelope, root-first, root AGENTS.md excluded
  expect(appended).toBe(true)
  const injected = String(event.result.content)
  expect(injected.startsWith("read output\n\n" + DIRECTORY_AGENTS_MARKER)).toBe(true)
  expect(injected).toContain("ROOT_README")
  expect(injected).toContain("SRC_RULE")
  expect(injected).toContain("SRC_README")
  expect(injected).toContain("NESTED_RULE")
  expect(injected).not.toContain("ROOT_RULE")
  expect(injected).toContain('<agents-file path="src/AGENTS.md">')
  expect(injected).toContain('<project-readme path="README.md">')
  expect(injected.indexOf("ROOT_README")).toBeLessThan(injected.indexOf("SRC_RULE"))
  expect(injected.indexOf("SRC_RULE")).toBeLessThan(injected.indexOf("SRC_README"))
  expect(injected.indexOf("SRC_README")).toBeLessThan(injected.indexOf("NESTED_RULE"))
  expect(injected).not.toContain("[Note: Content was truncated")
})

test("appends a text part when the read result content is an array", () => {
  // given a read result that carries structured text parts
  const root = makeRoot("rigel-directory-array-")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "ARRAY_RULE")
  fs.writeFileSync(path.join(root, "src", "file.ts"), "export {}")
  const store = createDirectoryInstructionStore({ directory: root })
  const event = { status: "completed", tool: "read", sessionID: "ses_array", input: { path: "src/file.ts" }, result: { content: [{ type: "text", text: "read output" }] } }

  // when the read is processed
  const appended = store.after(event)

  // then a new text part carries the envelope and the original part is untouched
  expect(appended).toBe(true)
  expect(event.result.content).toHaveLength(2)
  expect(event.result.content[0]).toEqual({ type: "text", text: "read output" })
  expect(event.result.content[1].type).toBe("text")
  expect(event.result.content[1].text).toContain("ARRAY_RULE")
})

test("rejects a read target outside the workspace root", () => {
  // given a workspace with an instruction file inside it
  const root = makeRoot("rigel-directory-outside-")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "SRC_RULE")
  const store = createDirectoryInstructionStore({ directory: root })
  const event = readEvent("../outside.txt", "ses_1")

  // when a path that escapes the workspace is read
  const appended = store.after(event)

  // then nothing is appended
  expect(appended).toBe(false)
  expect(event.result.content).toBe("read output")
})

test("dedupes per directory so a second read in the same directory appends nothing", () => {
  // given a store that already appended for a read in src/nested
  const root = makeRoot("rigel-directory-dedup-")
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "SRC_RULE")
  fs.writeFileSync(path.join(root, "src", "nested", "one.ts"), "export {}")
  fs.writeFileSync(path.join(root, "src", "nested", "two.ts"), "export {}")
  const store = createDirectoryInstructionStore({ directory: root })
  const first = readEvent("src/nested/one.ts", "ses_1")
  expect(store.after(first)).toBe(true)
  const afterFirst = String(first.result.content)

  // when a sibling file in the same directory is read
  const second = readEvent("src/nested/two.ts", "ses_1")
  const appendedAgain = store.after(second)

  // then the directory is already covered and the second result is untouched
  expect(appendedAgain).toBe(false)
  expect(second.result.content).toBe("read output")
  expect(afterFirst).toContain("SRC_RULE")
})

test("clear resets a session so a re-read appends again", () => {
  // given a session that already appended
  const root = makeRoot("rigel-directory-clear-")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "SRC_RULE")
  fs.writeFileSync(path.join(root, "src", "file.ts"), "export {}")
  const store = createDirectoryInstructionStore({ directory: root })
  const first = readEvent("src/file.ts", "ses_1")
  expect(store.after(first)).toBe(true)

  // when the session is cleared after a compaction
  store.clear("ses_1")
  const second = readEvent("src/file.ts", "ses_1")

  // then the same read appends the context again
  expect(store.after(second)).toBe(true)
  expect(String(second.result.content)).toContain("SRC_RULE")
})

test("truncates oversized instruction files with the V1 truncation notice", () => {
  // given an AGENTS.md far beyond the 50 000-token budget
  const root = makeRoot("rigel-directory-truncate-")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  const agentsFile = path.join(root, "src", "AGENTS.md")
  fs.writeFileSync(agentsFile, `# header one\n# header two\n# header three\n${"x".repeat(250_000)}`)
  fs.writeFileSync(path.join(root, "src", "file.ts"), "export {}")
  const store = createDirectoryInstructionStore({ directory: root })
  const event = readEvent("src/file.ts", "ses_1")

  // when the file is read
  store.after(event)
  const injected = String(event.result.content)

  // then the token truncator ran and the V1 notice names the real path
  expect(injected).toContain("[Note: Content was truncated to save context window space. For full context, please read the file directly: ")
  expect(injected).toContain(fs.realpathSync(agentsFile))
  expect(injected).toContain("truncated due to context window limit")
})

test("renders only the workspace-root AGENTS.md for the Hephaestus session-start path", () => {
  // given root and nested instruction files
  const root = makeRoot("rigel-hephaestus-rules-")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT_HEPHAESTUS_RULE")
  fs.writeFileSync(path.join(root, "README.md"), "ROOT_README_MUST_NOT_BE_INCLUDED")
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "NESTED_RULE_MUST_NOT_BE_INCLUDED")
  const store = createDirectoryInstructionStore({ directory: root })

  // when the Hephaestus root guidance is requested before any read
  const injected = store.rootAgentsGuidance()

  // then only the root AGENTS.md is rendered, regardless of skipRoot
  expect(injected).toContain("ROOT_HEPHAESTUS_RULE")
  expect(injected).not.toContain("ROOT_README_MUST_NOT_BE_INCLUDED")
  expect(injected).not.toContain("NESTED_RULE_MUST_NOT_BE_INCLUDED")
})

test("ignores non-read and non-completed events and identifies the directory envelope marker", () => {
  // given a store and an unrelated event
  const root = makeRoot("rigel-directory-nonread-")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "SRC_RULE")
  const store = createDirectoryInstructionStore({ directory: root })

  // when a write and an incomplete read are processed
  const writeEvent = { status: "completed", tool: "write", sessionID: "ses_1", input: { path: "src/AGENTS.md" }, result: { content: "written" } }
  const incomplete = { status: "error", tool: "read", sessionID: "ses_1", input: { path: "src/AGENTS.md" }, result: { content: "boom" } }

  // then both are ignored and the marker identifies an injected system message
  expect(store.after(writeEvent)).toBe(false)
  expect(store.after(incomplete)).toBe(false)
  expect(isDirectoryInstructionMessage({ role: "system", content: `${DIRECTORY_AGENTS_MARKER} block` })).toBe(true)
  expect(isDirectoryInstructionMessage({ role: "user", content: DIRECTORY_AGENTS_MARKER })).toBe(false)
})
