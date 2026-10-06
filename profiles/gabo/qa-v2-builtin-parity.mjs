#!/usr/bin/env bun
/**
 * Parity contract: the deployed native `glob`/`grep` tools versus the V1
 * owner contract under `packages/omo-opencode/src/tools/{glob,grep}`.
 *
 * The host builtin is NOT V1-equivalent: it excludes hidden files by default in
 * `glob`, always includes them in `grep`, uses different result formats, does not
 * follow or cap depth the same way, exposes no V1 output modes and omits the V1
 * per-file limits. The runtime therefore ships native ports (see
 * `opencode/tools/glob-grep*.mjs`) registered under the same tool names. This
 * contract asserts that the SAME observable call the model made in V1 produces
 * the SAME result: it drives the live tool with V1-shaped arguments only and
 * compares the model-visible content against the V1 owner output.
 *
 * Comparison semantics:
 *   - Header line and the set of body lines are compared exactly (canonical
 *     form). Across-file ordering is not a V1 contract for grep and is
 *     nondeterministic under ripgrep's parallel walker, so it is not asserted;
 *     the glob mtime-desc order IS contractual and is asserted separately.
 *   - Cases whose selection is order-dependent above the result cap (glob 100 of
 *     105 files, grep head_limit 2) are checked structurally (header, count,
 *     truncation note).
 *
 * Consequences:
 *   - Against the deployed adaptation every check passes.
 *   - Against the raw host builtin the same checks fail (hidden default, format,
 *     modes, limits), so the contract is not vacuous.
 *
 * Surface: the isolated V2 laboratory (`opencode-v2-lab.service`) over its HTTP
 * API. This file never spawns OpenCode, never uses Docker and never addresses
 * V1. The V1 oracle runs the owner functions in-process with an explicit
 * `/usr/bin/rg`, so no production V1 cache path is probed.
 *
 * Usage: bun profiles/gabo/qa-v2-builtin-parity.mjs
 * Env: RIGEL_V2_LAB_ROOT, RIGEL_V2_LAB_URL, RIGEL_V2_SERVICE, RIGEL_V2_HOME,
 *      RIGEL_PARITY_SUT_LABEL, RIGEL_PARITY_REPORT_NAME,
 *      RIGEL_PARITY_READY_TIMEOUT_MS, RIGEL_PARITY_RETRIES.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runRgFiles } from "../../packages/omo-opencode/src/tools/glob/cli.ts"
import { formatGlobResult } from "../../packages/omo-opencode/src/tools/glob/result-formatter.ts"
import { runRg, runRgCount } from "../../packages/omo-opencode/src/tools/grep/cli.ts"
import { formatGrepResult, formatCountResult } from "../../packages/omo-opencode/src/tools/grep/result-formatter.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const baseUrl = process.env.RIGEL_V2_LAB_URL || "http://127.0.0.1:4097"
const service = process.env.RIGEL_V2_SERVICE || "opencode-v2-lab.service"
const labHome = process.env.RIGEL_V2_HOME || path.join(labRoot, "home")
const secretFile = path.join(labRoot, "secret.env")
const evidenceDir = path.join(root, ".omo/evidence/20261007-builtin-glob-grep-parity")
const sutLabel = process.env.RIGEL_PARITY_SUT_LABEL || "deployed-native-adaptation"
const reportName = process.env.RIGEL_PARITY_REPORT_NAME || "parity-verdicts.json"
const agent = process.env.RIGEL_PARITY_AGENT || "Sisyphus-Junior"
const READY_TIMEOUT_MS = Number(process.env.RIGEL_PARITY_READY_TIMEOUT_MS || 90_000)
const RETRIES = Number(process.env.RIGEL_PARITY_RETRIES || 2)
const REMINDER = "Agent Usage Reminder"

const fixture = path.join(labHome, "rigel-glob-grep-parity-fixture")
const subdir = path.join(fixture, "nested")
const manyDir = path.join(fixture, "many")
const missingPath = "/home/rigel-glob-grep-parity-missing"

const sessions = []

function skip(reason) {
  console.log(`Rigel V2 builtin glob/grep parity: SKIP (${reason})`)
  process.exit(0)
}

function readPassword() {
  if (!fs.existsSync(secretFile)) return null
  const line = fs.readFileSync(secretFile, "utf8").split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  const value = line ? line.slice("OPENCODE_PASSWORD=".length) : ""
  return value || null
}

const password = readPassword()
if (!password) skip(`no lab credentials at ${secretFile}`)
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

async function api(method, pathname, body, timeoutMs = 180_000) {
  try {
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    return { status: response.status, json: text ? JSON.parse(text) : null }
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// Deterministic fixture, including every pertinent V1 limit
// ---------------------------------------------------------------------------

function buildFixture() {
  fs.rmSync(fixture, { recursive: true, force: true })
  fs.mkdirSync(path.join(subdir, "deep"), { recursive: true })
  fs.mkdirSync(path.join(fixture, "empty"), { recursive: true })
  fs.mkdirSync(path.join(fixture, ".git"), { recursive: true })
  fs.mkdirSync(manyDir, { recursive: true })
  fs.writeFileSync(path.join(fixture, "alpha.txt"), "ALPHA token line1\nbeta line2\nALPHA again line3\n")
  fs.writeFileSync(path.join(fixture, "beta.txt"), "beta only\n")
  fs.writeFileSync(path.join(subdir, "gamma.txt"), "nested ALPHA content\n")
  fs.writeFileSync(path.join(subdir, "deep", "delta.txt"), "deep ALPHA content\nmore ALPHA here\n")
  fs.writeFileSync(path.join(fixture, ".hidden.txt"), "hidden ALPHA\n")
  fs.writeFileSync(path.join(fixture, ".git", "config"), "git object\n")
  fs.writeFileSync(path.join(fixture, "readme.md"), "nothing to see\n")
  // glob limit: 105 files against the V1 cap of 100. `.log` keeps them out of
  // the `**/*.txt` case so both stay single-purpose.
  for (let index = 0; index < 105; index += 1) {
    fs.writeFileSync(path.join(manyDir, `entry-${String(index).padStart(3, "0")}.log`), `log line ${index}\n`)
  }
  // grep max-count: 600 matching lines against the V1 per-file cap of 500.
  const hits = []
  for (let index = 0; index < 600; index += 1) hits.push(`HIT ${index}`)
  fs.writeFileSync(path.join(fixture, "hits.hit"), `${hits.join("\n")}\n`)
  // grep max-columns: a matching line longer than the V1 cap of 1000 columns.
  fs.writeFileSync(path.join(fixture, "longline.long"), `LONGPATTERN ${"x".repeat(2000)}\n`)
  // grep max-filesize: a file larger than the V1 cap of 10M.
  fs.writeFileSync(path.join(fixture, "big.bin"), `BIGPADDING\n${"y".repeat(11 * 1024 * 1024)}`)
}

// ---------------------------------------------------------------------------
// V1 oracle: the owner contract functions, in-process
// ---------------------------------------------------------------------------

function resolveRipgrep() {
  for (const candidate of ["/usr/bin/rg", "/usr/local/bin/rg", "/bin/rg"]) {
    if (fs.existsSync(candidate)) return candidate
  }
  const found = spawnSync("which", ["rg"], { encoding: "utf8" })
  return (found.stdout || "").split("\n").map((line) => line.trim()).find(Boolean) || null
}

async function v1Oracle(cli) {
  const out = {}
  const glob = async (options) => {
    const raw = await runRgFiles(options, cli)
    return { formatted: formatGlobResult(raw), error: raw.error !== undefined, total: raw.totalFiles, truncated: raw.truncated }
  }
  const grep = async (options) => {
    const raw = await runRg({ context: 0, outputMode: "content", headLimit: 0, ...options }, cli)
    return { formatted: formatGrepResult(raw), error: raw.error !== undefined, total: raw.totalMatches, truncated: raw.truncated }
  }
  const count = async (options) => {
    const raw = await runRgCount(options, cli)
    return { formatted: formatCountResult(raw), error: false, total: raw.reduce((sum, entry) => sum + entry.count, 0) }
  }
  out.glob_txt = await glob({ pattern: "**/*.txt", paths: [fixture] })
  out.glob_md = await glob({ pattern: "*.md", paths: [fixture] })
  out.glob_empty = await glob({ pattern: "**/*.zzz", paths: [fixture] })
  out.glob_subdir = await glob({ pattern: "**/*.txt", paths: [subdir] })
  out.glob_missing = await glob({ pattern: "**/*.txt", paths: [missingPath] })
  out.glob_limit = await glob({ pattern: "**/*.log", paths: [fixture] })
  out.grep_files = await (async () => {
    const raw = await runRg({ pattern: "ALPHA", paths: [fixture], outputMode: "files_with_matches", context: 0, headLimit: 0 }, cli)
    return { formatted: formatGrepResult(raw), error: raw.error !== undefined, total: raw.totalMatches }
  })()
  out.grep_content = await grep({ pattern: "ALPHA", paths: [fixture], outputMode: "content" })
  out.grep_count = await count({ pattern: "ALPHA", paths: [fixture] })
  out.grep_include = await grep({ pattern: "beta", paths: [fixture], globs: ["*.txt"], outputMode: "content" })
  out.grep_headlimit = await grep({ pattern: "ALPHA", paths: [fixture], outputMode: "content", headLimit: 2 })
  out.grep_empty = await grep({ pattern: "ZZZNOPE", paths: [fixture], outputMode: "content" })
  out.grep_invalid = await grep({ pattern: "(", paths: [fixture], outputMode: "content" })
  out.grep_maxcount = await grep({ pattern: "HIT", paths: [fixture], outputMode: "content" })
  out.grep_maxfilesize = await grep({ pattern: "BIGPADDING", paths: [fixture], outputMode: "content" })
  out.grep_maxcolumns = await grep({ pattern: "LONGPATTERN", paths: [fixture], outputMode: "content" })
  return out
}

// ---------------------------------------------------------------------------
// Live capture through the isolated laboratory
// ---------------------------------------------------------------------------

function canonical(value) {
  return JSON.stringify(value ?? {}, Object.keys(value ?? {}).sort())
}

function toolParts(context) {
  return (context ?? []).flatMap((message) =>
    message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool") : [],
  )
}

async function waitForIdle(sessionID) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const context = await api("GET", `/api/session/${sessionID}/context`, undefined, 20_000)
    const messages = Array.isArray(context.json?.data) ? context.json.data : []
    if (messages.some((message) => message.type === "idle" || message.type === "error")) return messages
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  return null
}

async function captureBuiltin(tool, args) {
  const prompt = [
    `Call the ${tool} tool exactly once with these exact arguments:`,
    JSON.stringify(args),
    "Do not use bash or code mode. Do not answer from memory. Do not add or drop fields. After the tool returns, reply DONE.",
  ].join("\n")
  for (let attempt = 1; attempt <= RETRIES + 1; attempt += 1) {
    const created = await api("POST", "/api/session", { agent, location: { directory: labHome } })
    if (created.status !== 200) return { ok: false, reason: `session create ${created.status}` }
    const sessionID = created.json.id ?? created.json.data?.id
    if (typeof sessionID !== "string") return { ok: false, reason: "no session id" }
    sessions.push(sessionID)
    await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt, resume: true })
    const context = await waitForIdle(sessionID)
    if (!context) return { ok: false, reason: "never idle" }
    const part = toolParts(context).find((candidate) => candidate.name === tool)
    if (part && canonical(part.state?.input) === canonical(args)) {
      const blocks = (part.state?.content ?? []).filter((block) => block.type === "text").map((block) => block.text)
      return {
        ok: true,
        status: part.state?.status,
        content: blocks[0] ?? "",
        error: part.state?.error?.message,
        decorated: blocks.length > 1 && blocks.slice(1).some((block) => block.includes(REMINDER)),
        attempt,
      }
    }
  }
  return { ok: false, reason: `input not honored (${tool})` }
}

// ---------------------------------------------------------------------------
// Cases and comparisons
// ---------------------------------------------------------------------------

const CASES = [
  { id: "glob_txt", tool: "glob", args: { pattern: "**/*.txt", path: fixture } },
  { id: "glob_md", tool: "glob", args: { pattern: "*.md", path: fixture } },
  { id: "glob_empty", tool: "glob", args: { pattern: "**/*.zzz", path: fixture } },
  { id: "glob_subdir", tool: "glob", args: { pattern: "**/*.txt", path: subdir } },
  { id: "glob_missing", tool: "glob", args: { pattern: "**/*.txt", path: missingPath }, kind: "error" },
  { id: "glob_limit", tool: "glob", args: { pattern: "**/*.log", path: fixture }, kind: "structural" },
  { id: "grep_files", tool: "grep", args: { pattern: "ALPHA", path: fixture } },
  { id: "grep_content", tool: "grep", args: { pattern: "ALPHA", path: fixture, output_mode: "content" } },
  { id: "grep_count", tool: "grep", args: { pattern: "ALPHA", path: fixture, output_mode: "count" } },
  { id: "grep_include", tool: "grep", args: { pattern: "beta", path: fixture, include: "*.txt", output_mode: "content" } },
  { id: "grep_headlimit", tool: "grep", args: { pattern: "ALPHA", path: fixture, output_mode: "content", head_limit: 2 }, kind: "structural" },
  { id: "grep_empty", tool: "grep", args: { pattern: "ZZZNOPE", path: fixture } },
  { id: "grep_invalid", tool: "grep", args: { pattern: "(", path: fixture }, kind: "error" },
  { id: "grep_maxcount", tool: "grep", args: { pattern: "HIT", path: fixture, output_mode: "content" } },
  { id: "grep_maxfilesize", tool: "grep", args: { pattern: "BIGPADDING", path: fixture, output_mode: "content" } },
  { id: "grep_maxcolumns", tool: "grep", args: { pattern: "LONGPATTERN", path: fixture, output_mode: "content" } },
]

/** V1 grep has no across-file order contract; compare header + the set of body lines. */
function canonicalForm(text) {
  const lines = String(text).split("\n")
  return { header: lines[0], body: lines.slice(1).filter((line) => line !== "").sort() }
}
function sameForm(a, b) {
  const left = canonicalForm(a)
  const right = canonicalForm(b)
  return left.header === right.header && left.body.length === right.body.length && left.body.every((line, index) => line === right.body[index])
}
function globPaths(content) {
  return String(content).split("\n").filter((line) => line.startsWith("/"))
}
function globOrderNonIncreasing(content) {
  const times = globPaths(content).map((file) => {
    try {
      return fs.statSync(file).mtime.getTime()
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return 0
    }
  })
  return times.every((time, index) => index === 0 || times[index - 1] >= time)
}

const STRUCTURAL = {
  glob_limit: (content) =>
    /^Found 100 file\(s\)\n/.test(content) &&
    content.includes("(Results are truncated. Consider using a more specific path or pattern.)") &&
    globPaths(content).length === 100 &&
    globOrderNonIncreasing(content),
  grep_headlimit: (content) =>
    /^Found 2 match\(es\) in \d+ file\(s\)/.test(content) &&
    content.includes("[Output truncated due to size limit]") &&
    (content.match(/^ {2}\d+: /gm) || []).length === 2,
}

const V1_CONTRACT = {
  glob_txt: (content) => /^Found 5 file\(s\)\n/.test(content) && content.includes(path.join(fixture, ".hidden.txt")),
  glob_md: (content) => /^Found 1 file\(s\)\n/.test(content) && globOrderNonIncreasing(content),
  glob_subdir: (content) => /^Found 2 file\(s\)\n/.test(content) && globOrderNonIncreasing(content),
  glob_empty: (content) => content.trim() === "No files found",
  grep_files: (content) => /^Found 3 match\(es\) in 3 file\(s\)/.test(content) && !content.includes(".hidden.txt"),
  grep_content: (content) => /^Found 5 match\(es\) in 3 file\(s\)/.test(content) && !content.includes(".hidden.txt"),
  grep_count: (content) => /^Found 5 match\(es\) in 3 file\(s\):/.test(content),
  grep_include: (content) => /^Found 2 match\(es\) in 2 file\(s\)/.test(content),
  grep_maxcount: (content) => /^Found 500 match\(es\) in 1 file\(s\)/.test(content),
  grep_maxfilesize: (content) => content.trim() === "No matches found",
  grep_maxcolumns: (content) => content.includes("[Omitted long matching line]"),
}

async function waitForLabReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const info = await api("GET", "/api/info", undefined, 10_000)
    if (info.status === 200 && info.json?.version) return info.json
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const active = spawnSync("systemctl", ["--user", "is-active", service], { encoding: "utf8" }).stdout?.trim()
  if (active !== "active") skip(`${service} is not active`)
  const info = await waitForLabReady()
  if (!info) skip(`lab not reachable at ${baseUrl}`)
  const rg = resolveRipgrep()
  if (!rg) skip("ripgrep binary not found for the V1 oracle")

  buildFixture()
  const v1 = await v1Oracle({ path: rg, backend: "rg" })

  const checks = []
  const captures = {}
  for (const caseDef of CASES) {
    const capture = await captureBuiltin(caseDef.tool, caseDef.args)
    captures[caseDef.id] = capture
    const expected = v1[caseDef.id]
    if (!capture.ok) {
      checks.push({ name: `${caseDef.id}.captured`, pass: false, detail: capture.reason })
      continue
    }
    if (caseDef.kind === "error") {
      const v1Error = expected.formatted.startsWith("Error:")
      const v2Error = capture.status === "completed" && typeof capture.content === "string" && capture.content.startsWith("Error:")
      checks.push({ name: `${caseDef.id}.errorShape`, pass: v1Error && v2Error, detail: { v1: expected.formatted.slice(0, 120), v2: (capture.error ?? capture.content).slice(0, 120), status: capture.status } })
      continue
    }
    if (caseDef.kind === "structural") {
      checks.push({ name: `${caseDef.id}.equalsV1`, pass: capture.status === "completed" && STRUCTURAL[caseDef.id](capture.content), detail: (capture.content ?? capture.error ?? "").slice(0, 200) })
    } else {
      checks.push({ name: `${caseDef.id}.equalsV1`, pass: capture.status === "completed" && sameForm(capture.content, expected.formatted), detail: { v1: canonicalForm(expected.formatted).header, v2: canonicalForm(capture.content).header, v1Lines: canonicalForm(expected.formatted).body.length, v2Lines: canonicalForm(capture.content).body.length } })
    }
    if (V1_CONTRACT[caseDef.id]) {
      checks.push({ name: `${caseDef.id}.v1Contract`, pass: capture.status === "completed" && V1_CONTRACT[caseDef.id](capture.content), detail: (capture.content ?? capture.error ?? "").slice(0, 160) })
    }
  }

  const decorated = Object.values(captures).filter((capture) => capture.decorated === true).length
  checks.push({ name: "nativeRuntime.decoratesBuiltins", pass: decorated > 0, detail: { decorated, of: CASES.length } })

  const failed = checks.filter((check) => !check.pass).map((check) => check.name)
  const report = {
    sut: sutLabel,
    service,
    baseUrl,
    spawnedOpenCode: false,
    dockerUsed: false,
    v1Addressed: false,
    ripgrep: rg,
    fixture,
    sessions: sessions.length,
    equivalence: {
      schema: "V1 tool schema registered under the same names (glob: pattern/path; grep: pattern/include/path/output_mode/head_limit)",
      hidden: "glob includes hidden by default and follows; grep excludes hidden and does not follow, exactly as V1",
      format: "model-visible header and body lines equal the V1 owner formatter output",
      order: "glob results are mtime-descending; grep across-file order is not contractual and is not asserted",
      limits: "glob 100 results; grep max-count 500, max-columns 1000, max-filesize 10M, max-depth 20, head_limit, 60s timeout",
    },
    checks,
    failed,
  }
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, "v1-owner-oracle.json"), `${JSON.stringify(v1, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(evidenceDir, "v2-live-captures.json"), `${JSON.stringify(captures, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(evidenceDir, reportName), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ sut: sutLabel, passed: checks.length - failed.length, total: checks.length, failed }, null, 2))
  if (failed.length > 0) {
    console.error(`Rigel V2 builtin glob/grep parity FAILED against ${sutLabel}: ${failed.join(", ")}`)
    process.exitCode = 1
  } else {
    console.log(`Rigel V2 builtin glob/grep parity PASS against ${sutLabel} (${checks.length} checks, live lab)`)
  }
} finally {
  for (const sessionID of sessions) {
    try {
      await api("DELETE", `/api/session/${sessionID}`)
    } catch (error) {
      console.error(`Could not remove isolated V2 session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    fs.rmSync(fixture, { recursive: true, force: true })
  } catch (error) {
    console.error(`Could not remove isolated fixture: ${error instanceof Error ? error.message : String(error)}`)
  }
}
