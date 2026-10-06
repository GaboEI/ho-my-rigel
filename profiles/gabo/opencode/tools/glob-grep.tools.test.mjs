import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createGlobTool,
  createGrepTool,
  GLOB_DESCRIPTION,
  GLOB_INPUT_SCHEMA,
  GREP_DESCRIPTION,
  GREP_INPUT_SCHEMA,
} from "./glob-grep.tools.mjs"
import {
  buildGlobRgArgs,
  buildGrepRgArgs,
  parseCountOutput,
  parseOutput,
  runRgFiles,
} from "./glob-grep-search.mjs"
import { formatCountResult, formatGrepResult, formatGlobResult } from "./glob-grep-format.mjs"

const stubResolver = { resolveWithAutoInstall: async () => ({ path: "/usr/bin/rg", backend: "rg" }) }

const temporary = []
afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true })
})

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-globgrep-"))
  temporary.push(root)
  return root
}

/** A minimal child-process stub: emits data then close on the next microtask. */
function fakeProcess({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const proc = new EventEmitter()
  const stream = (text) => {
    const handlers = { data: [], end: [] }
    return {
      on(type, cb) {
        ;(handlers[type] ??= []).push(cb)
        return this
      },
      emitData() {
        for (const cb of handlers.data) cb(Buffer.from(text))
      },
      emitEnd() {
        for (const cb of handlers.end) cb()
      },
    }
  }
  proc.stdout = stream(stdout)
  proc.stderr = stream(stderr)
  proc.kill = () => {}
  queueMicrotask(() => {
    proc.stdout.emitData()
    proc.stderr.emitData()
    proc.emit("close", exitCode)
  })
  return proc
}

describe("native glob tool contract", () => {
  test("#given the V1 glob schema #then it exposes only pattern and path with pattern required", () => {
    expect(Object.keys(GLOB_INPUT_SCHEMA.properties)).toEqual(["pattern", "path"])
    expect(GLOB_INPUT_SCHEMA.required).toEqual(["pattern"])
    expect(GLOB_INPUT_SCHEMA.additionalProperties).toBe(false)
    expect(GLOB_DESCRIPTION).toContain("100 file limit")
  })

  test("#given the V1 defaults #when building glob args #then hidden and follow are on and depth is capped", () => {
    const args = buildGlobRgArgs({ pattern: "**/*.txt" })
    expect(args).toContain("--hidden")
    expect(args).toContain("--follow")
    expect(args).toContain("--max-depth=20")
    expect(args).toContain("--threads=4")
    expect(args).toContain("--glob=!.git/*")
    expect(args).toContain("--glob=**/*.txt")
  })

  test("#given a spawner #when running the glob search #then files are resolved and sorted by mtime desc", async () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "older.txt"), "x")
    fs.writeFileSync(path.join(root, "newer.txt"), "x")
    const past = new Date(1_000_000_000_000)
    const future = new Date(2_000_000_000_000)
    fs.utimesSync(path.join(root, "older.txt"), past, past)
    fs.utimesSync(path.join(root, "newer.txt"), future, future)
    let captured
    const spawner = (command, options) => {
      captured = { command, options }
      return fakeProcess({ stdout: "older.txt\nnewer.txt\n" })
    }
    const result = await runRgFiles({ pattern: "**/*.txt", paths: [root] }, { cli: { path: "/usr/bin/rg", backend: "rg" }, spawner })
    expect(captured.command).toContain("--hidden")
    expect(result.files.map((entry) => path.basename(entry.path))).toEqual(["newer.txt", "older.txt"])
    expect(result.totalFiles).toBe(2)
  })

  test("#given the host diverges #when the tool executes #then it emits the V1 'Found N file(s)' format", async () => {
    const tool = createGlobTool({ resolver: stubResolver, directory: "/work", run: async () => ({ files: [{ path: "/work/a.txt", mtime: 1 }], totalFiles: 1, truncated: false }) })
    const result = await tool.execute({ pattern: "*.txt" }, { directory: "/work" })
    expect(result.content).toBe("Found 1 file(s)\n\n/work/a.txt")
  })

  test("#given an empty result #when the tool executes #then it emits the V1 no-files message", async () => {
    const tool = createGlobTool({ resolver: stubResolver, run: async () => ({ files: [], totalFiles: 0, truncated: false }) })
    const result = await tool.execute({ pattern: "**/*.zzz" })
    expect(result.content).toBe("No files found")
  })
})

describe("native grep tool contract", () => {
  test("#given the V1 grep schema #then it exposes the V1 option set with pattern required", () => {
    expect(Object.keys(GREP_INPUT_SCHEMA.properties)).toEqual(["pattern", "include", "path", "output_mode", "head_limit"])
    expect(GREP_INPUT_SCHEMA.required).toEqual(["pattern"])
    expect(GREP_INPUT_SCHEMA.properties.output_mode.enum).toEqual(["content", "files_with_matches", "count"])
    expect(GREP_DESCRIPTION).toContain("256KB output")
  })

  test("#given the V1 defaults #when building grep args #then hidden stays off and per-file limits are present", () => {
    const args = buildGrepRgArgs({ pattern: "ALPHA" })
    expect(args).not.toContain("--hidden")
    expect(args).toContain("--no-follow")
    expect(args).toContain("--max-count=500")
    expect(args).toContain("--max-columns=1000")
    expect(args).toContain("--max-filesize=10M")
    expect(args).toContain("--max-depth=20")
  })

  test("#given an include filter #when building grep args #then the include glob is carried", () => {
    const args = buildGrepRgArgs({ pattern: "beta", globs: ["*.txt"] })
    expect(args).toContain("--glob=*.txt")
  })

  test("#given a files_with_matches call #when the tool executes #then the V1 header and file list are emitted", async () => {
    const tool = createGrepTool({
      resolver: stubResolver,
      run: async () => ({ matches: [{ file: "/work/a.txt", line: 0, text: "" }], totalMatches: 1, filesSearched: 1, truncated: false }),
    })
    const result = await tool.execute({ pattern: "ALPHA" })
    expect(result.content).toBe("Found 1 match(es) in 1 file(s)\n\n/work/a.txt\n")
  })

  test("#given a count call #when the tool executes #then the V1 count format is emitted", async () => {
    const tool = createGrepTool({ resolver: stubResolver, runCount: async () => [{ file: "/work/a.txt", count: 2 }] })
    const result = await tool.execute({ pattern: "ALPHA", output_mode: "count" })
    expect(result.content).toBe("Found 2 match(es) in 1 file(s):\n\n       2: /work/a.txt")
  })

  test("#given the default output mode #then it is files_with_matches like V1", async () => {
    const tool = createGrepTool({ resolver: stubResolver, run: async () => ({ matches: [], totalMatches: 0, filesSearched: 0, truncated: false }) })
    const result = await tool.execute({ pattern: "NOPE" })
    expect(result.content).toBe("No matches found")
  })
})

describe("V1 output formatting and parsing", () => {
  test("#given a truncated glob result #then the V1 truncation note is appended", () => {
    const text = formatGlobResult({ files: [{ path: "/a.txt" }], totalFiles: 1, truncated: true })
    expect(text).toContain("(Results are truncated. Consider using a more specific path or pattern.)")
  })

  test("#given grep content matches #then the V1 '  line: text' format is emitted", () => {
    const text = formatGrepResult({ matches: [{ file: "/a.txt", line: 1, text: " ALPHA " }], totalMatches: 1, filesSearched: 1, truncated: false })
    expect(text).toBe("Found 1 match(es) in 1 file(s)\n\n/a.txt\n  1: ALPHA\n")
  })

  test("#given a count list #then it is sorted descending like V1", () => {
    const text = formatCountResult([{ file: "/a.txt", count: 1 }, { file: "/b.txt", count: 3 }])
    expect(text.indexOf("/b.txt")).toBeLessThan(text.indexOf("/a.txt"))
  })

  test("#given rg output #when parsing #then file, line and text are extracted", () => {
    expect(parseOutput("/a.txt:2:hello\n")).toEqual([{ file: "/a.txt", line: 2, text: "hello" }])
    expect(parseOutput("/a.txt\n", true)).toEqual([{ file: "/a.txt", line: 0, text: "" }])
  })

  test("#given count output #when parsing #then file and count are extracted", () => {
    expect(parseCountOutput("/a.txt:4\n")).toEqual([{ file: "/a.txt", count: 4 }])
  })
})
