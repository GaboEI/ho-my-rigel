#!/usr/bin/env node
/**
 * T21 compaction-context propagation contract (re-graded 2026-10-06).
 *
 * The 2026-10-02 edition drove a test-only inline plugin and recorded the
 * V2.0.22 gap: `event.system` mutations in the `compaction` hook do not reach
 * the compaction summary request. That expectation was inverted relative to
 * the accepted contract: the T21 live experiment proved that `event.messages`
 * mutations DO reach the provider summary body, so the native runtime now
 * carries the V1 `output.context` effect through the A1 hook
 * (`rigel-v2-native-compaction-context.mjs`).
 *
 * This edition drives the REAL native runtime in a disposable V2 server and
 * asserts the positive contract: the compaction summary request body carries
 * the marked context block. Never uses `event.result` and never mutates
 * `event.system`.
 *
 * Run: node profiles/gabo/qa-v2-compaction-hook-contract.mjs
 */
import childProcess from "node:child_process"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const evidence = path.join(root, ".omo/evidence/20261006-t21-compaction/native-contract")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-compaction-"))
const configHome = path.join(temporary, "config")
const home = path.join(temporary, "home")
const runtime = path.join(temporary, "plugin")
const traceFile = path.join(temporary, "provider-trace.jsonl")
const providerPort = 41364
const serverPort = 41365
const url = `http://127.0.0.1:${serverPort}`
const password = "rigel-v2-compaction-contract"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const COMPACTION_CONTEXT_MARKER = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT]"
const SUMMARY_PREFIXES = ["You MUST summarize", "Update the existing checkpoint", "The previous response did not fill"]

function save(name, value) {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidence, name), value, { mode: 0o600 })
}

function waitFor(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try { if (await check()) return resolve() } catch { /* starting */ }
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(attempt, 100)
    }
    attempt()
  })
}

async function api(pathname, init = {}) {
  const response = await fetch(`${url}${pathname}`, { ...init, headers: { authorization, ...init.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

function copyRuntimeFile(name) {
  const destination = path.join(runtime, name === "rigel-v2-native.mjs" ? "index.js" : name)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(root, "profiles/gabo/opencode", name), destination)
}

/** Latest user message text from a serialized provider trace row. */
function latestUserText(row) {
  const items = Array.isArray(row?.messages) ? row.messages : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.role !== "user") continue
    if (typeof item.content === "string") return item.content
    if (Array.isArray(item.content)) return item.content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
    return ""
  }
  return ""
}

function traceRows(traceText) {
  return String(traceText ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

/**
 * Deterministic idle wait documented by the V2 server API
 * (`POST /api/experimental/session/{sessionID}/wait`). Falls back to the
 * bounded condition waits already in place when the running binary does not
 * expose the experimental endpoint; the fallback is recorded in the report.
 */
async function waitIdle(sessionID, timeout = 20_000) {
  try {
    await fetch(`${url}/api/experimental/session/${sessionID}/wait`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeout),
    })
    return "wait-endpoint"
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return "wait-endpoint-timeout"
    return "unavailable-fallback-polling"
  }
}

function isSummaryRequest(row) {
  return SUMMARY_PREFIXES.some((prefix) => latestUserText(row).startsWith(prefix))
}

async function main() {
  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  copyRuntimeFile("rigel-v2-native.mjs")
  for (const name of discoverRuntimeModules(path.join(root, "profiles/gabo/opencode"))) copyRuntimeFile(name)
  fs.copyFileSync(path.join(root, "packages/prompts-core/prompts/ultrawork/default.md"), path.join(runtime, "prompts/ultrawork-default.md"))
  fs.writeFileSync(path.join(runtime, "rigel-v2-native-agent-manifest.mjs"), `export default ${JSON.stringify({
    defaultAgent: "Sisyphus - ultraworker",
    modes: { defaultUltrawork: false },
    agents: {
      "Sisyphus - ultraworker": { mode: "primary", name: "Sisyphus - ultraworker", model: "rigel-fixture/fixture", prompt: "Coordinate the request." },
    },
  })}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel fixture", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1000000, output: 8192 } } } } },
    model: "rigel-fixture/fixture", plugin: [runtime], default_agent: "Sisyphus - ultraworker",
  }, null, 2) + "\n", { mode: 0o600 })

  // RIGEL_FAKE_TASK_NAME names a tool the native runtime never registers, so
  // `hasTaskTool` is false and every primary request returns the parent reply:
  // the drive stays a pure compaction loop with no delegation side effects.
  const env = { ...buildIsolatedV2Env({ sandbox: temporary, home: home }), OPENCODE_SERVER_PASSWORD: password }
  const provider = childProcess.spawn(process.execPath, [path.join(root, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], {
    env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "no_such_tool", RIGEL_FAKE_PARENT_REPLY: "WORK_DONE" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const server = childProcess.spawn(binary, ["--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  const logs = []
  for (const stream of [provider.stdout, provider.stderr, server.stdout, server.stderr]) stream?.on("data", (data) => logs.push(data.toString()))
  try {
    await waitFor(() => fetch(`${url}/api/session/active`, { headers: { authorization } }).then((response) => response.ok), "V2 server did not start")
    const created = await api("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Sisyphus - ultraworker", location: { directory: root } }) })
    const sessionID = created.id ?? created.data?.id
    if (typeof sessionID !== "string") throw new Error("V2 did not create a session")

    // First run finishes so the compaction admitted below executes at the
    // nudge run's step boundary.
    await api(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Prepare to compact.", resume: true }) })
    await waitFor(
      () => fs.existsSync(traceFile) && traceRows(fs.readFileSync(traceFile, "utf8")).filter((row) => row.responseKind === "complete").length >= 1,
      "the first run did not finish",
      25_000,
    )

    // Durably admit the compaction request, then nudge one more run so the
    // summary executes at the next step boundary. The deterministic idle wait
    // replaces fixed sleep-polling between the two runs.
    await api(`/api/session/${sessionID}/compact`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })
    const waitIdleOutcomes = [await waitIdle(sessionID)]
    await api(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Continue now.", resume: true }) })

    await waitFor(
      () => traceRows(fs.readFileSync(fs.existsSync(traceFile) ? traceFile : path.join(temporary, "missing"), "utf8")).some((row) => isSummaryRequest(row)),
      "the compaction summary request did not reach the provider",
      30_000,
    ).catch(() => { /* absence is the failing contract; recorded below */ })
    // Deterministic idle wait for the nudge run before reading the evidence.
    waitIdleOutcomes.push(await waitIdle(sessionID))

    const trace = fs.readFileSync(traceFile, "utf8")
    const log = logs.join("")
    save("provider-trace.jsonl", trace)
    save("server.txt", log)
    const rows = traceRows(trace)
    const summaryRows = rows.filter((row) => isSummaryRequest(row))
    const propagated = summaryRows.some((row) => JSON.stringify(row).includes(COMPACTION_CONTEXT_MARKER))
    const compactionHookRan = log.includes("compaction") || summaryRows.length > 0
    const report = [
      "# Rigel V2 compaction-context propagation contract (T21, re-graded)",
      "",
      "- Real isolated V2 server with the native runtime: yes.",
      `- Compaction summary requests at the provider: ${summaryRows.length}.`,
      `- Summary body carries the marked context block: ${propagated ? "yes" : "no"}.`,
      "- Injection seam: `session.hook(\"compaction\")` mutating `event.messages` (V2 message parts; string content crashes SessionModelRequest.prepare).",
      "- `event.system` mutation and `event.result` replacement: not used.",
      "",
      `- Deterministic idle waits (session.wait): ${waitIdleOutcomes.join(", ") || "none"}.`,
      propagated
        ? "- Finding: the native A1 seam carries the V1 compaction-context effect into the real summary request."
        : "- Finding: the marked block did not reach the summary request; the contract FAILS.",
    ].join("\n") + "\n"
    save("validation.md", report)
    process.stdout.write(report)
    if (summaryRows.length === 0 || !propagated || !compactionHookRan) process.exitCode = 1
  } catch (error) {
    save("provider-trace.jsonl", fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "")
    save("server.txt", logs.join(""))
    throw error
  } finally { server.kill("SIGTERM"); provider.kill("SIGTERM") }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
