import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  HASHLINE_DICT,
  NIBBLE_STR,
  HashlineMismatchError,
  canCreateFromMissingFile,
  computeLegacyLineHash,
  computeLineHash,
  createHashlineEditTool,
  createHashlineReadEnhancer,
  formatHashLine,
  formatHashLines,
  normalizeLineRef,
  parseLineRef,
  transformReadOutput,
  validateLineRefs,
  xxHash32Fallback,
} from "./rigel-v2-native-hashline.mjs"

// V1 owners, imported only for parity in the test process (Bun resolves TS).
import {
  computeLegacyLineHash as realLegacyHash,
  computeLineHash as realHash,
  formatHashLine as realFmt,
} from "../../../packages/hashline-core/src/hash-computation"

function capture(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

function otherHash(line, content) {
  const actual = computeLineHash(line, content)
  return actual === "ZZ" ? "ZP" : "ZZ"
}

describe("Rigel native V2 hashline", () => {
  describe("#given the native port and the V1 hashline core", () => {
    describe("#when line hashes are computed for representative content", () => {
      test("#then computeLineHash and computeLegacyLineHash match V1", () => {
        const samples = [
          [1, "# Title"],
          [2, "const x = 1"],
          [3, "   "],
          [4, ""],
          [5, "  indented()"],
          [6, "日本語のテキスト"],
          [7, "x".repeat(40)],
          [8, "  trailing spaces   "],
        ]
        for (const [line, content] of samples) {
          expect(computeLineHash(line, content)).toBe(realHash(line, content))
          expect(computeLegacyLineHash(line, content)).toBe(realLegacyHash(line, content))
        }
      })

      test("#then formatHashLine output matches V1", () => {
        const samples = [
          [1, "alpha"],
          [12, "  return true"],
          [3, ""],
        ]
        for (const [line, content] of samples) {
          expect(formatHashLine(line, content)).toBe(realFmt(line, content))
        }
      })
    })

    describe("#when the pure-JS xxHash32 fallback runs next to Bun's native binding", () => {
      test("#then both produce the same 32-bit hash for short and long inputs", () => {
        const samples = [
          "",
          "a",
          "alpha",
          "x".repeat(15),
          "y".repeat(16),
          "the quick brown fox jumps over the lazy dog",
          "日本語のテキスト行",
          "line with trailing spaces   ",
        ]
        for (const sample of samples) {
          expect(xxHash32Fallback(sample, 0)).toBe(Bun.hash.xxHash32(sample, 0))
          expect(xxHash32Fallback(sample, 42)).toBe(Bun.hash.xxHash32(sample, 42))
        }
      })
    })

    describe("#when the nibble dictionary is built", () => {
      test("#then it is the 256 unique two-letter alphabet pairs", () => {
        expect(NIBBLE_STR).toBe("ZPMQVRWSNKTXJBYH")
        expect(HASHLINE_DICT).toHaveLength(256)
        expect(new Set(HASHLINE_DICT).size).toBe(256)
        expect(HASHLINE_DICT[0]).toBe("ZZ")
        expect(HASHLINE_DICT[255]).toBe("HH")
      })
    })

    describe("#when formatHashLines tags multi-line content", () => {
      test("#then every line carries its own LINE#ID tag", () => {
        expect(formatHashLines("a\nb")).toBe(`${formatHashLine(1, "a")}\n${formatHashLine(2, "b")}`)
      })
    })
  })

  describe("#given a file whose current lines are known", () => {
    describe("#when every reference matches its hash", () => {
      test("#then validation resolves without throwing", () => {
        const lines = ["alpha", "beta", "gamma"]
        const ref = `${2}#${computeLineHash(2, "beta")}`
        expect(() => validateLineRefs(lines, [ref])).not.toThrow()
      })
    })

    describe("#when a reference hash is stale", () => {
      test("#then it throws a mismatch naming the changed line and marking it with >>>", () => {
        const lines = ["alpha", "beta", "gamma"]
        const error = capture(() => validateLineRefs(lines, [`2#${otherHash(2, "beta")}`]))

        expect(error).toBeInstanceOf(HashlineMismatchError)
        expect(error.message).toContain("changed since last read")
        expect(error.message).toContain(">>>")
        expect(error.remaps.size).toBe(1)
      })
    })

    describe("#when a line reference is malformed", () => {
      test("#then parseLineRef rejects it with the format message", () => {
        expect(() => parseLineRef("not a ref")).toThrow(
          'Invalid line reference format: "not a ref". Expected format: "{line_number}#{hash_id}"'
        )
        expect(() => parseLineRef("abc#ZP")).toThrow(
          '"abc" is not a line number. Use the actual line number from the read output.'
        )
      })

      test("#then normalizeLineRef strips markers, spacing, and trailing content", () => {
        expect(normalizeLineRef(">>> 12 # ZP |old content")).toBe("12#ZP")
        expect(normalizeLineRef("+ 7#ZP")).toBe("7#ZP")
        expect(parseLineRef("  12 # ZP |old")).toEqual({ line: 12, hash: "ZP" })
      })
    })
  })

  describe("#given the read output enhancer", () => {
    describe("#when colon-shaped read lines are transformed", () => {
      test("#then each line becomes n#hh|content", () => {
        const input = "1: alpha\n2: beta"
        const output = transformReadOutput(input)
        expect(output).toBe(
          [`1#${computeLineHash(1, "alpha")}|alpha`, `2#${computeLineHash(2, "beta")}|beta`].join("\n")
        )
      })
    })

    describe("#when a content block carries an inline first line", () => {
      test("#then the block body is tagged and the envelope is preserved", () => {
        const input = "<content>3: gamma\n4: delta\n</content>"
        const output = transformReadOutput(input)
        expect(output).toBe(
          [
            "<content>",
            `3#${computeLineHash(3, "gamma")}|gamma`,
            `4#${computeLineHash(4, "delta")}|delta`,
            "</content>",
          ].join("\n")
        )
      })
    })

    describe("#when a file block uses pipe-shaped lines", () => {
      test("#then the body is tagged and the tags are left in place", () => {
        const input = "<file>\n1|one\n2|two\n</file>"
        const output = transformReadOutput(input)
        expect(output).toBe(
          ["<file>", `1#${computeLineHash(1, "one")}|one`, `2#${computeLineHash(2, "two")}|two`, "</file>"].join("\n")
        )
      })
    })

    describe("#when the output carries no read-line block", () => {
      test("#then a system-reminder line is left untouched", () => {
        const input = "<system-reminder>\nremember this\n</system-reminder>"
        expect(transformReadOutput(input)).toBe(input)
      })
    })

    describe("#when the output is a real V2 read result with a header line", () => {
      test("#then the header is preserved and the numbered lines are tagged", () => {
        const input = "Read file /tmp/x.txt, lines 1-3\n1: alpha\n2: beta\n3: gamma"
        const output = transformReadOutput(input).split("\n")
        expect(output[0]).toBe("Read file /tmp/x.txt, lines 1-3")
        expect(output[1]).toBe(`1#${computeLineHash(1, "alpha")}|alpha`)
        expect(output[2]).toBe(`2#${computeLineHash(2, "beta")}|beta`)
        expect(output[3]).toBe(`3#${computeLineHash(3, "gamma")}|gamma`)
      })
    })

    describe("#when a line ends with the truncation suffix", () => {
      test("#then that line stays unhashed while its neighbours are tagged", () => {
        const input = "1: alpha\n2: beta ... (line truncated to 2000 chars)\n3: gamma"
        const output = transformReadOutput(input).split("\n")
        expect(output[0]).toBe(`1#${computeLineHash(1, "alpha")}|alpha`)
        expect(output[1]).toBe("2: beta ... (line truncated to 2000 chars)")
        expect(output[2]).toBe(`3#${computeLineHash(3, "gamma")}|gamma`)
      })
    })

    describe("#when a line is not parseable as a read line", () => {
      test("#then tagging stops and the remainder is copied verbatim", () => {
        const input = "1: alpha\nnot a read line\n2: beta"
        const output = transformReadOutput(input).split("\n")
        expect(output[0]).toBe(`1#${computeLineHash(1, "alpha")}|alpha`)
        expect(output[1]).toBe("not a read line")
        expect(output[2]).toBe("2: beta")
      })
    })
  })

  describe("#given the enhancer driven by the V2 tool.execute.after event", () => {
    describe("#when a completed read event carries a string result", () => {
      test("#then result.content is tagged and after reports a change", async () => {
        const enhancer = createHashlineReadEnhancer()
        const event = { status: "completed", tool: "read", sessionID: "ses_x", result: { content: "1: a\n2: b" } }

        const changed = await enhancer.after(event)

        expect(changed).toBe(true)
        expect(event.result.content).toBe(
          `1#${computeLineHash(1, "a")}|a\n2#${computeLineHash(2, "b")}|b`
        )
      })
    })

    describe("#when a completed read event carries text parts", () => {
      test("#then each text part is tagged in place", async () => {
        const enhancer = createHashlineReadEnhancer()
        const tagged = { type: "text", text: "1: a\n2: b" }
        const plain = { type: "text", text: "not a read block" }
        const event = { status: "completed", tool: "read", sessionID: "ses_parts", result: { content: [tagged, plain] } }

        const changed = await enhancer.after(event)

        expect(changed).toBe(true)
        expect(tagged.text).toBe(`1#${computeLineHash(1, "a")}|a\n2#${computeLineHash(2, "b")}|b`)
        expect(plain.text).toBe("not a read block")
      })
    })

    describe("#when a read result is not a read block", () => {
      test("#then a system-reminder body is left untouched and after reports no change", async () => {
        const enhancer = createHashlineReadEnhancer()
        const body = "<system-reminder>\nremember this\n</system-reminder>"
        const event = { status: "completed", tool: "read", sessionID: "ses_neg", result: { content: body } }

        const changed = await enhancer.after(event)

        expect(changed).toBe(false)
        expect(event.result.content).toBe(body)
      })
    })

    describe("#when a read result line is truncated", () => {
      test("#then that line stays unhashed", async () => {
        const enhancer = createHashlineReadEnhancer()
        const event = {
          status: "completed",
          tool: "read",
          sessionID: "ses_trunc",
          result: { content: "1: alpha\n2: beta ... (line truncated to 2000 chars)" },
        }

        const changed = await enhancer.after(event)

        expect(changed).toBe(true)
        expect(event.result.content).toBe(
          `1#${computeLineHash(1, "alpha")}|alpha\n2: beta ... (line truncated to 2000 chars)`
        )
      })
    })

    describe("#when the event is not a completed call", () => {
      test("#then after reports no change and leaves the content alone", async () => {
        const enhancer = createHashlineReadEnhancer()
        const event = { status: "error", tool: "read", sessionID: "ses_err", result: { content: "1: a" } }

        const changed = await enhancer.after(event)

        expect(changed).toBe(false)
        expect(event.result.content).toBe("1: a")
      })
    })

    describe("#when the tool is unknown or the event is malformed", () => {
      test("#then after reports no change without throwing", async () => {
        const enhancer = createHashlineReadEnhancer()
        expect(await enhancer.after(undefined)).toBe(false)
        expect(await enhancer.after({ tool: "glob" })).toBe(false)
        expect(await enhancer.after({ status: "completed", tool: "read" })).toBe(false)
      })
    })

    describe("#when a completed write event has file metadata", () => {
      test("#then result.content is replaced with the write marker", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rigel-hashline-write-"))
        const target = join(dir, "out.txt")
        writeFileSync(target, "a\nb\nc\n")
        try {
          const enhancer = createHashlineReadEnhancer()
          const event = {
            status: "completed",
            tool: "write",
            sessionID: "ses_w",
            result: { content: "", metadata: { filePath: target } },
          }

          const changed = await enhancer.after(event)

          expect(changed).toBe(true)
          expect(event.result.content).toBe("File written successfully. 4 lines written.")
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })

      test("#then an already-final write marker is left unchanged", async () => {
        const enhancer = createHashlineReadEnhancer()
        const marker = "File written successfully. 2 lines written."
        const event = { status: "completed", tool: "write", sessionID: "ses_w2", result: { content: marker } }

        const changed = await enhancer.after(event)

        expect(changed).toBe(false)
        expect(event.result.content).toBe(marker)
      })
    })
  })

  describe("#given the hashline_edit tool over a real file", () => {
    let dir
    let file

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "rigel-hashline-"))
      file = join(dir, "sample.txt")
    })

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    describe("#when a valid anchor replaces a line", () => {
      test("#then the edit applies and the result reports Updated", async () => {
        writeFileSync(file, "alpha\nbeta\ngamma\n")
        const tool = createHashlineEditTool({ directory: dir })
        const anchor = `2#${computeLineHash(2, "beta")}`

        const result = await tool.execute({ filePath: file, edits: [{ op: "replace", pos: anchor, lines: ["BETA"] }] })

        expect(result).toBe(`Updated ${file}`)
        expect(readFileSync(file, "utf8")).toBe("alpha\nBETA\ngamma\n")
      })
    })

    describe("#when the anchor hash is stale", () => {
      test("#then the tool returns a hash mismatch error and leaves the file untouched", async () => {
        writeFileSync(file, "alpha\nbeta\ngamma\n")
        const tool = createHashlineEditTool({ directory: dir })
        const stale = `2#${otherHash(2, "beta")}`

        const result = await tool.execute({ filePath: file, edits: [{ op: "replace", pos: stale, lines: ["X"] }] })

        expect(result.startsWith("Error: hash mismatch - ")).toBe(true)
        expect(result).toContain("changed since last read")
        expect(readFileSync(file, "utf8")).toBe("alpha\nbeta\ngamma\n")
      })
    })

    describe("#when the replacement equals the current content", () => {
      test("#then the tool reports no changes", async () => {
        writeFileSync(file, "alpha\nbeta\ngamma\n")
        const tool = createHashlineEditTool({ directory: dir })
        const anchor = `2#${computeLineHash(2, "beta")}`

        const result = await tool.execute({ filePath: file, edits: [{ op: "replace", pos: anchor, lines: ["beta"] }] })

        expect(result.startsWith(`Error: No changes made to ${file}. The edits produced identical content.`)).toBe(true)
      })
    })

    describe("#when BOM and CRLF content is edited", () => {
      test("#then the original byte envelope is restored", async () => {
        writeFileSync(file, "\uFEFFalpha\r\nbeta\r\n")
        const tool = createHashlineEditTool({ directory: dir })
        const anchor = `2#${computeLineHash(2, "beta")}`

        const result = await tool.execute({ filePath: file, edits: [{ op: "replace", pos: anchor, lines: ["BETA"] }] })

        expect(result).toBe(`Updated ${file}`)
        expect(readFileSync(file, "utf8")).toBe("\uFEFFalpha\r\nBETA\r\n")
      })
    })

    describe("#when a missing file is seeded by an anchorless append", () => {
      test("#then the file is created", async () => {
        const created = join(dir, "created.txt")
        const tool = createHashlineEditTool({ directory: dir })

        const result = await tool.execute({ filePath: created, edits: [{ op: "append", lines: ["hello"] }] })

        expect(result).toBe(`Updated ${created}`)
        expect(readFileSync(created, "utf8")).toBe("hello")
      })
    })

    describe("#when a missing file is edited with a replace anchor", () => {
      test("#then the tool reports the file is missing", async () => {
        const missing = join(dir, "absent.txt")
        const tool = createHashlineEditTool({ directory: dir })

        const result = await tool.execute({ filePath: missing, edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }] })

        expect(result).toBe(`Error: File not found: ${missing}`)
      })
    })

    describe("#when delete and rename are combined", () => {
      test("#then the guard refuses before touching the file", async () => {
        const tool = createHashlineEditTool({ directory: dir })
        expect(await tool.execute({ filePath: file, delete: true, rename: "x", edits: [] })).toBe(
          "Error: delete and rename cannot be used together"
        )
      })
    })

    describe("#when delete mode carries edits", () => {
      test("#then the guard requires an empty edits array", async () => {
        const tool = createHashlineEditTool({ directory: dir })
        expect(await tool.execute({ filePath: file, delete: true, edits: [{ op: "append", lines: ["x"] }] })).toBe(
          "Error: delete mode requires edits to be an empty array"
        )
      })
    })

    describe("#when a non-delete edit passes no operations", () => {
      test("#then the guard requires a non-empty edits array", async () => {
        const tool = createHashlineEditTool({ directory: dir })
        expect(await tool.execute({ filePath: file, edits: [] })).toBe("Error: edits parameter must be a non-empty array")
      })
    })
  })

  describe("#given the missing-file creation predicate", () => {
    describe("#when every edit is an anchorless append or prepend", () => {
      test("#then it allows creation", () => {
        expect(canCreateFromMissingFile([{ op: "append", lines: ["x"] }])).toBe(true)
        expect(canCreateFromMissingFile([{ op: "prepend", lines: ["x"] }])).toBe(true)
      })
    })

    describe("#when an edit is anchored or replaces", () => {
      test("#then it refuses creation", () => {
        expect(canCreateFromMissingFile([{ op: "replace", pos: "1#ZZ", lines: ["x"] }])).toBe(false)
        expect(canCreateFromMissingFile([{ op: "append", pos: "1#ZZ", lines: ["x"] }])).toBe(false)
        expect(canCreateFromMissingFile([])).toBe(false)
      })
    })
  })
})
