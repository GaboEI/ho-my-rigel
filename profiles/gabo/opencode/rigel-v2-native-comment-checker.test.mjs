import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createNativeCommentChecker,
  resolveCommentCheckerBinary,
  runCommentChecker,
  stripAllowedComments,
  isFileDisabled,
} from "./rigel-v2-native-comment-checker.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-comment-checker-"))
  temporary.push(dir)
  return dir
}

function editInput(newString, oldString = "const x = 1\n") {
  return {
    session_id: "ses_test",
    tool_name: "Edit",
    transcript_path: "",
    cwd: process.cwd(),
    hook_event_name: "PostToolUse",
    tool_input: { file_path: "/tmp/rigel-cc-sample.ts", old_string: oldString, new_string: newString },
  }
}

function injectedChecker(runner, extra = {}) {
  return createNativeCommentChecker({
    env: { OMO_COMMENT_CHECKER_BIN: "/fake/comment-checker" },
    homedir: "/nonexistent",
    existsSync: () => true,
    readFileSync: () => "",
    now: () => 1_700_000_000_000,
    runner,
    ...extra,
  })
}

function flagging(calls) {
  return async (_binary, input) => { calls.push(input); return { hasComments: true, message: "SLOP" } }
}

describe("Rigel native V2 comment-checker bypass helpers", () => {
  test("#given a line with @allow #when stripping #then the marker and its following comment are removed", () => {
    const stripped = stripAllowedComments("// @allow\n// obviously simple\nconst x = 1\n")
    expect(stripped).not.toContain("@allow")
    expect(stripped).not.toContain("obviously simple")
    expect(stripped).toContain("const x = 1")
  })

  test("#given a file-disable marker as the new content leading line #when checking #then the file is disabled", () => {
    const call = { tool: "write", content: "// comment-checker-disable-file\n// x\n", filePath: "a.ts" }
    expect(isFileDisabled(call, { existsSync: () => false })).toBe(true)
  })

  test("#given a file-disable marker only on disk #when checking an edit #then the file is disabled", () => {
    const dir = tempDir()
    const file = path.join(dir, "on-disk.ts")
    fs.writeFileSync(file, "# comment-checker-disable-file\n# existing\n")
    const call = { tool: "edit", oldString: "x", newString: "y", filePath: file }
    expect(isFileDisabled(call, { existsSync: fs.existsSync, readFileSync: fs.readFileSync })).toBe(true)
  })

  test("#given no marker #when checking #then the file is not disabled", () => {
    const call = { tool: "write", content: "const x = 1\n", filePath: "a.ts" }
    expect(isFileDisabled(call, { existsSync: () => false })).toBe(false)
  })
})

describe("Rigel native V2 comment-checker contracts (write, edit, multiedit)", () => {
  test("#given a write with a slop comment #when run #then the runner is invoked and the message is appended", async () => {
    const calls = []
    const checker = injectedChecker(flagging(calls))
    checker.before({ id: "w1", tool: "write", sessionID: "ses_w", input: { path: "b.ts", content: "// increment counter\nconst y = 2\n" } })
    const event = { id: "w1", tool: "write", sessionID: "ses_w", result: { content: "" } }
    expect(await checker.after(event)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(event.result.content).toContain("SLOP")
  })

  test("#given a write whose content is file-disabled #when run #then the runner is never invoked", async () => {
    const calls = []
    const checker = injectedChecker(flagging(calls))
    checker.before({ id: "w2", tool: "write", sessionID: "ses_w2", input: { path: "c.ts", content: "// comment-checker-disable-file\n// increment counter\nconst y = 2\n" } })
    expect(await checker.after({ id: "w2", tool: "write", sessionID: "ses_w2", result: { content: "" } })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("#given a write whose only comment is @allow-marked #when run #then the runner is never invoked", async () => {
    const calls = []
    const checker = injectedChecker(flagging(calls))
    checker.before({ id: "w3", tool: "write", sessionID: "ses_w3", input: { path: "d.ts", content: "// @allow\n// obviously simple\nconst y = 2\n" } })
    expect(await checker.after({ id: "w3", tool: "write", sessionID: "ses_w3", result: { content: "" } })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("#given an edit adding a new comment #when run #then the runner is invoked", async () => {
    const calls = []
    const checker = injectedChecker(flagging(calls))
    checker.before({ id: "e1", tool: "edit", sessionID: "ses_e", input: { path: "e.ts", oldString: "const x = 1\n", newString: "// new comment\nconst x = 1\n" } })
    expect(await checker.after({ id: "e1", tool: "edit", sessionID: "ses_e", result: { content: "" } })).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test("#given an edit whose new comment is @allow-marked #when run #then the runner is never invoked", async () => {
    const calls = []
    const checker = injectedChecker(flagging(calls))
    checker.before({ id: "e2", tool: "edit", sessionID: "ses_e2", input: { path: "f.ts", oldString: "const x = 1\n", newString: "// @allow\n// new comment\nconst x = 1\n" } })
    expect(await checker.after({ id: "e2", tool: "edit", sessionID: "ses_e2", result: { content: "" } })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("#given a multiedit adding a new comment #when run #then the runner is invoked", async () => {
    const calls = []
    const checker = injectedChecker(flagging(calls))
    const edits = [{ old_string: "const a = 1\n", new_string: "// multi comment\nconst a = 1\n" }]
    checker.before({ id: "m1", tool: "multiedit", sessionID: "ses_m", input: { path: "g.ts", edits } })
    expect(await checker.after({ id: "m1", tool: "multiedit", sessionID: "ses_m", result: { content: "" } })).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test("#given a multiedit whose new comment is @allow-marked #when run #then the runner is never invoked", async () => {
    const calls = []
    const checker = injectedChecker(flagging(calls))
    const edits = [{ old_string: "const a = 1\n", new_string: "// @allow\n// multi comment\nconst a = 1\n" }]
    checker.before({ id: "m2", tool: "multiedit", sessionID: "ses_m2", input: { path: "h.ts", edits } })
    expect(await checker.after({ id: "m2", tool: "multiedit", sessionID: "ses_m2", result: { content: "" } })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("#given an edit to a file disabled on disk #when run #then the runner is never invoked", async () => {
    const dir = tempDir()
    const file = path.join(dir, "disabled-on-disk.ts")
    fs.writeFileSync(file, "// comment-checker-disable-file\nconst x = 1\n")
    const calls = []
    const checker = createNativeCommentChecker({
      env: { OMO_COMMENT_CHECKER_BIN: "/fake/comment-checker" },
      now: () => 1_700_000_000_000,
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      runner: flagging(calls),
    })
    checker.before({ id: "d1", tool: "edit", sessionID: "ses_d", input: { path: file, oldString: "const x = 1\n", newString: "// new comment\nconst x = 1\n" } })
    expect(await checker.after({ id: "d1", tool: "edit", sessionID: "ses_d", result: { content: "" } })).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe("Rigel native V2 comment-checker binary resolution", () => {
  test("#given an env override #when resolving #then it wins", () => {
    const dir = tempDir()
    const binary = path.join(dir, "comment-checker")
    fs.writeFileSync(binary, "#!/bin/true\n")
    expect(resolveCommentCheckerBinary({ env: { OMO_COMMENT_CHECKER_BIN: binary }, homedir: dir, existsSync: fs.existsSync })).toBe(binary)
  })

  test("#given a stale cache marker #when resolving #then the slot is ignored", () => {
    const home = tempDir()
    const cache = path.join(home, ".cache", "oh-my-opencode", "bin")
    fs.mkdirSync(cache, { recursive: true })
    const binary = path.join(cache, process.platform === "win32" ? "comment-checker.exe" : "comment-checker")
    fs.writeFileSync(binary, "x")
    fs.writeFileSync(`${binary}.version`, "0.7.0\n")
    expect(resolveCommentCheckerBinary({ env: { PATH: "" }, homedir: home, existsSync: fs.existsSync, readFileSync: fs.readFileSync })).toBeUndefined()
  })
})

const realBinary = resolveCommentCheckerBinary({ env: { ...process.env, XDG_CACHE_HOME: path.join(os.homedir(), ".cache") }, homedir: os.homedir() })
if (!realBinary) console.error("[comment-checker.test] real binary unavailable at the pinned cache slot; live-binary assertions are skipped")
const realTest = realBinary ? test : test.skip

describe("Rigel native V2 comment-checker real binary protocol", () => {
  realTest("#given a clean edit #when the real binary checks it #then exit 0 reports no comments", async () => {
    expect((await runCommentChecker({ binaryPath: realBinary, hookInput: editInput("const x = 2\n") })).hasComments).toBe(false)
  })

  realTest("#given a slop edit #when the real binary checks it #then exit 2 reports comments", async () => {
    const result = await runCommentChecker({ binaryPath: realBinary, hookInput: editInput("// increment counter\nconst x = 1\n") })
    expect(result.hasComments).toBe(true)
    expect(result.message).toContain("COMMENT")
  })
})
