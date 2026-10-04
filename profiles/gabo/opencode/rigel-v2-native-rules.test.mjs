import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import picomatch from "picomatch"
import { createNativeRulesInjector, matchesGlob } from "./rigel-v2-native-rules.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

const PICOMATCH_OPTIONS = { dot: true, bash: true }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-rules-"))
  temporary.push(root)
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.mkdirSync(path.join(root, ".omo", "rules"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "subject.ts"), "export const subject = 1\n")
  return root
}

function readEvent(filePath, sessionID, content = "read output") {
  return { status: "completed", tool: "read", sessionID, input: { path: filePath }, result: { content } }
}

function transcriptMessage(text) {
  return { type: "assistant", content: [{ type: "text", text }] }
}

function transcript(relativePaths) {
  return {
    data: relativePaths.map((relativePath) => transcriptMessage(`\n\n[Rule: ${relativePath}]\n[Match: alwaysApply]\nPRIOR_BODY`)),
  }
}

describe("Rigel native V2 rules injector", () => {
  test("appends a matching project rule to the same V2 read result once", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "typescript.md"), "---\nglobs:\n  - src/**/*.ts\n---\nUSE_TYPESCRIPT_RULE\n")
    const rules = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const input = { status: "completed", tool: "read", sessionID: "ses_rule", input: { path: "src/subject.ts" }, result: { content: "read output" } }
    expect(await rules.after(input)).toBe(true)
    expect(input.result.content).toContain("USE_TYPESCRIPT_RULE")
    expect(await rules.after(input)).toBe(false)
  })

  test("honors alwaysApply and ignores a rule outside the current path", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nALWAYS_RULE\n")
    fs.writeFileSync(path.join(root, ".omo", "rules", "python.md"), "---\nglobs: '**/*.py'\n---\nPYTHON_ONLY\n")
    const rules = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const input = { status: "completed", tool: "read", sessionID: "ses_rule", input: { path: "src/subject.ts" }, result: { content: "read output" } }
    await rules.after(input)
    expect(input.result.content).toContain("ALWAYS_RULE")
    expect(input.result.content).not.toContain("PYTHON_ONLY")
  })

  test("#given rules at different ancestor distances #when reading a nested file #then the closer rule is emitted first", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-rules-proximity-"))
    temporary.push(root)
    fs.mkdirSync(path.join(root, ".git"), { recursive: true })
    fs.mkdirSync(path.join(root, "a", "b", ".omo", "rules"), { recursive: true })
    fs.mkdirSync(path.join(root, ".omo", "rules"), { recursive: true })
    fs.writeFileSync(path.join(root, "a", "b", "subject.ts"), "export const subject = 1\n")
    fs.writeFileSync(path.join(root, "a", "b", ".omo", "rules", "near.md"), "---\nalwaysApply: true\n---\nNEAR_RULE\n")
    fs.writeFileSync(path.join(root, ".omo", "rules", "far.md"), "---\nalwaysApply: true\n---\nFAR_RULE\n")
    const rules = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const input = readEvent("a/b/subject.ts", "ses_proximity")

    expect(await rules.after(input)).toBe(true)

    const content = String(input.result.content)
    expect(content).toContain("NEAR_RULE")
    expect(content).toContain("FAR_RULE")
    expect(content.indexOf("NEAR_RULE")).toBeLessThan(content.indexOf("FAR_RULE"))
  })

  test("#given rule globs #when matching #then the native matcher agrees with picomatch dot+bash mode", () => {
    const corpus = [
      ["src/**/*.ts", "src/a/b.ts"],
      ["src/**/*.ts", "src/b.ts"],
      ["src/**/*.ts", "src/a/b.py"],
      ["**/*.py", "a/b/foo.py"],
      ["**/*.py", "foo.py"],
      ["**/*.py", "src/subject.ts"],
      ["*.ts", "src/a/b.ts"],
      ["src/*.ts", "src/a/b.ts"],
      ["a/**/b", "a/x/y/b"],
      ["a/**/b", "a/x/c"],
      ["**/{index,main}.ts", "src/index.ts"],
      ["**/{index,main}.ts", "src/other.ts"],
      ["**/*.{ts,tsx}", "a/x.tsx"],
      ["**/*.{ts,tsx}", "a/x.js"],
      ["src/?.ts", "src/a.ts"],
      ["src/?.ts", "src/ab.ts"],
      ["[ab]/*.ts", "a/x.ts"],
      ["[ab]/*.ts", "c/z.ts"],
      ["**/.*", ".hidden"],
      ["**/.*", "src/.hidden"],
      ["**/.*", "src/x.ts"],
      ["**/test/**", "src/test/y.js"],
      ["**/test/**", "src/test.js"],
      ["src/**", "src"],
      ["src/**", "src/a/b.ts"],
      ["!src/**/gen/*.ts", "src/gen/x.ts"],
      ["!src/**/gen/*.ts", "src/x.ts"],
      ["!**/*.ts", "foo.py"],
      ["!**/*.ts", "a/x.ts"],
    ]

    for (const [pattern, candidate] of corpus) {
      expect({ pattern, candidate, matches: matchesGlob(pattern, candidate) }).toEqual({
        pattern,
        candidate,
        matches: picomatch(pattern, PICOMATCH_OPTIONS)(candidate),
      })
    }
  })

  test("#given a rule with a negative glob #when the negative matches #then the rule is excluded", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "negatives.md"), '---\nglobs: ["**/*.ts", "!**/gen/**"]\n---\nNEGATIVE_RULE\n')
    const excluded = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const excludedInput = readEvent("src/gen/subject.ts", "ses_negative")
    const included = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const includedInput = readEvent("src/subject.ts", "ses_positive")

    expect(await excluded.after(excludedInput)).toBe(false)
    expect(excludedInput.result.content).not.toContain("NEGATIVE_RULE")
    expect(await included.after(includedInput)).toBe(true)
    expect(String(includedInput.result.content)).toContain("NEGATIVE_RULE")
  })

  test("#given a rule larger than the token budget #when appended #then the V1 truncation notice is emitted", async () => {
    const root = fixture()
    const bodyLines = ["HEADER_ONE", "HEADER_TWO", "HEADER_THREE"]
    for (let index = 0; index < 120; index += 1) bodyLines.push(`BODY_${index}_${"y".repeat(1990)}`)
    const bigBody = bodyLines.join("\n")
    fs.writeFileSync(path.join(root, ".omo", "rules", "big.md"), `---\nalwaysApply: true\n---\n${bigBody}\n`)
    const rules = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })
    const input = readEvent("src/subject.ts", "ses_truncation")

    expect(await rules.after(input)).toBe(true)

    const content = String(input.result.content)
    expect(content).toContain("[Note: Content was truncated to save context window space. For full context, please read the file directly: .omo/rules/big.md]")
    expect(content).toMatch(/\[\d+ more lines truncated due to context window limit\]/)
    expect(content.length).toBeLessThan(bigBody.length)
  })

  test("#given a rule already injected #when the session state is cleared #then the rule is appended again", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nCLEARABLE_RULE\n")
    const rules = createNativeRulesInjector({ directory: root, home: path.join(root, "home") })

    expect(await rules.after(readEvent("src/subject.ts", "ses_clear"))).toBe(true)
    expect(await rules.after(readEvent("src/subject.ts", "ses_clear"))).toBe(false)
    rules.clear("ses_clear")
    expect(await rules.after(readEvent("src/subject.ts", "ses_clear"))).toBe(true)
    rules.clearAll()
    expect(await rules.after(readEvent("src/subject.ts", "ses_clear"))).toBe(true)
  })

  test("#given a rule marker already present in the transcript #when the same rule matches #then hydration suppresses the duplicate emission", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nHYDRATED_RULE\n")
    const rules = createNativeRulesInjector({
      directory: root,
      home: path.join(root, "home"),
      getSessionMessages: async () => transcript([".omo/rules/always.md"]),
    })
    const input = readEvent("src/subject.ts", "ses_hydrated")

    expect(await rules.after(input)).toBe(false)
    expect(String(input.result.content)).not.toContain("HYDRATED_RULE")
  })

  test("#given one hydrated rule #when another rule matches #then only the unseen rule is emitted", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "seen.md"), "---\nalwaysApply: true\n---\nSEEN_RULE\n")
    fs.writeFileSync(path.join(root, ".omo", "rules", "unseen.md"), "---\nalwaysApply: true\n---\nFRESH_RULE\n")
    const rules = createNativeRulesInjector({
      directory: root,
      home: path.join(root, "home"),
      getSessionMessages: async () => transcript([".omo/rules/seen.md"]),
    })
    const input = readEvent("src/subject.ts", "ses_partial")

    expect(await rules.after(input)).toBe(true)
    expect(String(input.result.content)).not.toContain("SEEN_RULE")
    expect(String(input.result.content)).toContain("FRESH_RULE")
  })

  test("#given the transcript read throws #when a rule matches #then hydration degrades to empty and the rule is emitted", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nFALLBACK_RULE\n")
    const rules = createNativeRulesInjector({
      directory: root,
      home: path.join(root, "home"),
      getSessionMessages: async () => { throw new Error("transcript unavailable") },
    })
    const input = readEvent("src/subject.ts", "ses_throw")

    expect(await rules.after(input)).toBe(true)
    expect(String(input.result.content)).toContain("FALLBACK_RULE")
  })

  test("#given a hydrated rule #when the session is cleared #then hydration re-reads the transcript and still suppresses", async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nHYDRATED_RULE\n")
    let transcriptReads = 0
    const rules = createNativeRulesInjector({
      directory: root,
      home: path.join(root, "home"),
      getSessionMessages: async () => { transcriptReads += 1; return transcript([".omo/rules/always.md"]) },
    })

    expect(await rules.after(readEvent("src/subject.ts", "ses_rehydrate"))).toBe(false)
    rules.clear("ses_rehydrate")
    expect(await rules.after(readEvent("src/subject.ts", "ses_rehydrate"))).toBe(false)
    expect(transcriptReads).toBe(2)
  })
})
