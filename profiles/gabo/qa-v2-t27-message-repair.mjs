#!/usr/bin/env node
/**
 * T27 live experiment (lab-only): prove the V2 `context` hook message repair and
 * observe the native V2 reasoning surface.
 *
 * The lab service (`opencode-v2-lab.service`, port 4097) runs the refreshed
 * native runtime. A loopback Anthropic provider (profiles/gabo/fixtures/
 * fake-anthropic-messages.mjs) completes each turn, and a probe plugin listed
 * FIRST in the lab config captures the FINAL provider request body in a
 * `http.request` hook, so the correction is observed on the real wire payload.
 *
 * The probe seeds a crafted history at the `context` hook before the runtime's
 * hook runs. Cases:
 *   T27ORPHAN    orphan V2 tool-call (no result) -> runtime inserts the terminal
 *                result; the loopback accepts the repaired request.
 *   T27PAIRED    already-paired tool-call -> no repair (negative control).
 *   T27PREFILL   assistant tail on an Anthropic-prefill-rejecting model -> the
 *                runtime appends the synthetic user recovery turn.
 *   T27REASONOK  signed reasoning + tool-call -> observed: V2 emits
 *                `thinking(sig)` + `tool_use`; the plugin adds nothing.
 *   T27REASONBAD unsigned reasoning + tool-call -> observed: V2 decides (demote
 *                to text or thinking with empty signature); the plugin adds
 *                nothing. This documents that there is NO custom V1 thinking
 *                effect to port (the V1 hook was removed).
 *
 * Isolation: addresses only 127.0.0.1 (its own fixture port, and the lab 4097).
 * Refresh stops/starts ONLY opencode-v2-lab.service through
 * apply-v2-runtime-service.sh; V1 is read-only and its hash/counts are compared
 * before and after. No Docker, no direct opencode launch.
 *
 * Run: node profiles/gabo/qa-v2-t27-message-repair.mjs
 */
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const worktreeRoot = path.resolve(here, "../..")
const evidenceDir = path.join(worktreeRoot, ".omo/evidence/20261007-t27-thinking-prefill/experiments")
const probeDir = path.join(evidenceDir, "t27-probe")
const captureFile = path.join(evidenceDir, "probe-http-bodies.jsonl")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const receiptFile = path.join(labRoot, "state", "oh-my-rigel", "message-repair.json")
const labConfig = path.join(labRoot, "config/opencode/opencode.json")
const secretFile = path.join(labRoot, "secret.env")
const fixturePort = Number(process.env.RIGEL_T27_FIXTURE_PORT || "41270")
const labUrl = "http://127.0.0.1:4097"
const modelID = "anthropic/claude-opus-4-8"
const ORPHAN = "T27ORPHAN"
const PAIRED = "T27PAIRED"
const PREFILL = "T27PREFILL"
const REASON_OK = "T27REASONOK"
const REASON_BAD = "T27REASONBAD"

function readPassword() {
  const line = fs.readFileSync(secretFile, "utf8").split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  return line ? line.slice("OPENCODE_PASSWORD=".length).trim() : ""
}
const authorization = `Basic ${Buffer.from(`opencode:${readPassword()}`).toString("base64")}`

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")
}
function countFiles(directory) {
  let files = 0
  const walk = (current) => {
    let items = []
    try { items = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const itemPath = path.join(current, item.name)
      if (item.isDirectory()) walk(itemPath)
      else if (item.isFile()) files += 1
    }
  }
  walk(directory)
  return files
}
function snapshotV1() {
  const configDir = path.join(os.homedir(), ".config/opencode")
  const shareDir = path.join(os.homedir(), ".local/share/opencode")
  const stable = []
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const file = path.join(configDir, name)
    if (fs.existsSync(file)) stable.push(`${name}:${sha256(fs.readFileSync(file))}`)
  }
  return { configFiles: countFiles(configDir), shareFiles: countFiles(shareDir), configHash: sha256(stable.join("\n")) }
}

function waitFor(check, message, timeout = 180_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try { if (await check()) return resolve() } catch { /* starting */ }
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(attempt, 250)
    }
    attempt()
  })
}
async function labApi(pathname, init = {}) {
  const response = await fetch(`${labUrl}${pathname}`, { ...init, headers: { authorization, ...init.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}
async function waitIdleLab(sessionID, timeout = 60_000) {
  try {
    await fetch(`${labUrl}/api/experimental/session/${sessionID}/wait`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeout),
    })
    return "wait-endpoint"
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unavailable"
  }
}
async function newSession() {
  const created = await labApi("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: worktreeRoot } }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error(`session create failed: ${JSON.stringify(created).slice(0, 200)}`)
  return sessionID
}

function writeProbe() {
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(path.join(probeDir, "package.json"), JSON.stringify({
    name: "t27-probe",
    type: "module",
    exports: { ".": "./index.js" },
  }, null, 2) + "\n")
  fs.writeFileSync(path.join(probeDir, "index.js"), `
import fs from "node:fs"

const CAPTURE = ${JSON.stringify(captureFile)}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== "user") continue
    if (typeof message.content === "string") return message.content
    if (Array.isArray(message.content)) return message.content.map((part) => part?.text ?? "").join(" ")
  }
  return ""
}
function signed(text, signature) {
  return { type: "reasoning", text, providerMetadata: { anthropic: { signature } } }
}
function call(id) {
  return { type: "tool-call", id, name: "read", input: {} }
}
function result(id) {
  return { role: "tool", content: [{ type: "tool-result", id, name: "read", result: { type: "text", value: "ok" } }] }
}

const SEEDS = {
  "${ORPHAN}": [
    { id: "t27-o-u", role: "user", content: [{ type: "text", text: "${ORPHAN} go" }] },
    { id: "t27-o-a", role: "assistant", content: [call("c1")] },
  ],
  "${PAIRED}": [
    { id: "t27-p-u", role: "user", content: [{ type: "text", text: "${PAIRED} go" }] },
    { id: "t27-p-a", role: "assistant", content: [call("c1")] },
    { id: "t27-p-t", role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "ok" } }] },
  ],
  "${PREFILL}": [
    { id: "t27-f-u", role: "user", content: [{ type: "text", text: "${PREFILL} go" }] },
    { id: "t27-f-a", role: "assistant", content: [{ type: "text", text: "partial" }] },
  ],
  "${REASON_OK}": [
    { id: "t27-ro-u", role: "user", content: [{ type: "text", text: "${REASON_OK} go" }] },
    { id: "t27-ro-a", role: "assistant", content: [signed("plan", "sig-plan"), call("c1")] },
    result("c1"),
  ],
  "${REASON_BAD}": [
    { id: "t27-rb-u", role: "user", content: [{ type: "text", text: "${REASON_BAD} go" }] },
    { id: "t27-rb-a", role: "assistant", content: [{ type: "reasoning", text: "unsigned" }, call("c1")] },
    result("c1"),
  ],
}

export default {
  id: "t27-probe",
  async setup(ctx) {
    await ctx.session.hook("context", async (event) => {
      if (!Array.isArray(event?.messages)) return
      const text = lastUserText(event.messages)
      const marker = Object.keys(SEEDS).find((key) => text.includes(key))
      if (!marker) return
      event.messages.length = 0
      event.messages.push(...SEEDS[marker])
      console.error("[t27-probe] seeded " + marker)
    })
    await ctx.session.hook("http.request", async (input) => {
      try {
        const body = await input.request.clone().json()
        fs.appendFileSync(CAPTURE, JSON.stringify({ kind: input.kind, body }) + "\\n")
      } catch { /* a non-JSON request is not the model loop */ }
    })
  },
}
`)
}

function startFixture(traceFile) {
  const env = { ...process.env, RIGEL_FAKE_MODEL_PORT: String(fixturePort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_ANTHROPIC_REPLY: "T27_FIXTURE_OK" }
  const fixture = childProcess.spawn(process.execPath, [path.join(worktreeRoot, "profiles/gabo/fixtures/fake-anthropic-messages.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] })
  return { fixture }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}
function wireMessages(body) {
  return Array.isArray(body?.messages) ? body.messages : []
}
function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
}
/** The agent-loop request is the captured body carrying assistant turns. */
function primaryBody(caseResult) {
  const bodies = caseResult?.bodies ?? []
  return bodies.slice().sort((a, b) => (b.messages?.length ?? 0) - (a.messages?.length ?? 0))[0]
}
function partTypes(message) {
  return (message?.content ?? []).map((part) => part.type)
}
function toolResultCount(messages, callID) {
  let count = 0
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part?.type === "tool_result" && part.tool_use_id === callID) count += 1
    }
  }
  return count
}
function hasToolUse(messages, callID) {
  return messages.some((message) => (message.content ?? []).some((part) => part?.type === "tool_use" && part.id === callID))
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  writeProbe()
  const v1Before = snapshotV1()
  console.log(`[t27] V1 before: cfgHash=${v1Before.configHash.slice(0, 12)} config#${v1Before.configFiles} share#${v1Before.shareFiles}`)

  const original = fs.readFileSync(labConfig, "utf8")
  const traceFile = path.join(evidenceDir, "anthropic-fixture-trace.jsonl")
  fs.rmSync(traceFile, { force: true })
  fs.rmSync(captureFile, { force: true })
  const { fixture } = startFixture(traceFile)
  const journalSince = new Date().toISOString()

  let restored = false
  const restoreLab = () => {
    if (restored) return
    restored = true
    fs.writeFileSync(labConfig, original)
    childProcess.spawnSync("bash", [path.join(worktreeRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: worktreeRoot, stdio: "inherit", timeout: 300_000 })
  }

  const results = {}
  try {
    const config = JSON.parse(original)
    config.disabled_providers = (config.disabled_providers ?? []).filter((entry) => entry !== "anthropic")
    config.provider = config.provider ?? {}
    config.provider.anthropic = {
      ...(config.provider.anthropic ?? {}),
      options: { ...(config.provider.anthropic?.options ?? {}), baseURL: `http://127.0.0.1:${fixturePort}`, apiKey: "sk-ant-mock" },
    }
    config.model = modelID
    config.small_model = modelID
    const existing = Array.isArray(config.plugin) ? config.plugin.filter((entry) => entry !== probeDir) : []
    config.plugin = [probeDir, ...existing]
    fs.writeFileSync(labConfig, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })

    console.log(`[t27] refresh root=${worktreeRoot}; model=${modelID}`)
    const refresh = childProcess.spawnSync("bash", [path.join(worktreeRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: worktreeRoot, stdio: "inherit", timeout: 300_000 })
    if (refresh.status !== 0) throw new Error(`lab refresh failed with status ${refresh.status}`)
    await waitFor(async () => {
      try { const response = await fetch(`${labUrl}/api/info`, { headers: { authorization } }); await response.arrayBuffer(); return response.ok } catch { return false }
    }, "lab did not come back")

    for (const marker of [ORPHAN, PAIRED, PREFILL, REASON_OK, REASON_BAD]) {
      const before = readJsonl(captureFile).length
      fs.rmSync(receiptFile, { force: true })
      const sessionID = await newSession()
      await labApi(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${marker} go`, resume: true }),
      })
      const idle = await waitIdleLab(sessionID)
      const entries = readJsonl(captureFile).slice(before)
      const bodies = entries
        .filter((entry) => Array.isArray(entry.body?.messages) && JSON.stringify(entry.body.messages).includes(marker))
        .map((entry) => entry.body)
      let receipt = null
      try { receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) } catch { receipt = null }
      results[marker] = { sessionID, idle, bodies, receipt }
      fs.writeFileSync(path.join(evidenceDir, `T27-${marker}.json`), JSON.stringify(results[marker], null, 2) + "\n", { mode: 0o600 })
    }
  } finally {
    try { fixture.kill("SIGTERM") } catch { /* already gone */ }
    restoreLab()
  }

  // Observable runtime repair report: the context hook logs counts only.
  let journal = ""
  try {
    journal = childProcess.execFileSync("journalctl", ["--user", "-u", "opencode-v2-lab.service", "--since", journalSince, "--no-pager"], { encoding: "utf8", timeout: 30_000 })
  } catch { journal = "" }
  const repairLines = journal.split("\n").filter((line) => line.includes("native context message repair"))
  fs.writeFileSync(path.join(evidenceDir, "T27-runtime-repair-log.txt"), repairLines.join("\n") + "\n", { mode: 0o600 })

  // ---- Assertions on the captured provider bodies ----
  const failures = []
  const observations = {}

  const orphan = primaryBody(results[ORPHAN])
  if (!orphan) failures.push("orphan: no captured provider body")
  else {
    const messages = wireMessages(orphan)
    if (!hasToolUse(messages, "c1")) failures.push("orphan: tool_use c1 missing")
    if (toolResultCount(messages, "c1") !== 1) failures.push(`orphan: expected exactly one tool_result c1, got ${toolResultCount(messages, "c1")}`)
    if (results[ORPHAN].idle !== "wait-endpoint") failures.push(`orphan: turn did not complete (${results[ORPHAN].idle})`)
  }

  const paired = primaryBody(results[PAIRED])
  if (!paired) failures.push("paired: no captured provider body")
  else {
    const count = toolResultCount(wireMessages(paired), "c1")
    if (count !== 1) failures.push(`paired: repair inserted a duplicate (${count} tool_result c1)`)
  }

  const prefill = primaryBody(results[PREFILL])
  if (!prefill) failures.push("prefill: no captured provider body")
  else {
    const messages = wireMessages(prefill)
    const last = messages.at(-1)
    if (!(last?.role === "user" && contentText(last.content).includes("[internal] Continue from the previous assistant state."))) {
      failures.push("prefill: synthetic recovery turn not appended")
    }
  }

  const reasonOk = primaryBody(results[REASON_OK])
  if (!reasonOk) failures.push("reason-ok: no captured provider body")
  else {
    const messages = wireMessages(reasonOk)
    const assistant = messages.find((message) => hasToolUse([message], "c1"))
    const types = partTypes(assistant)
    observations.reasonSigned = types
    const thinking = (assistant?.content ?? []).filter((part) => part?.type === "thinking")
    if (thinking.length > 1) failures.push(`reason-ok: plugin added an extra thinking block (${thinking.length})`)
    if (types[0] !== "thinking" || types[1] !== "tool_use") failures.push(`reason-ok: unexpected wire shape ${JSON.stringify(types)}`)
  }

  const reasonBad = primaryBody(results[REASON_BAD])
  if (!reasonBad) failures.push("reason-bad: no captured provider body")
  else {
    const messages = wireMessages(reasonBad)
    const assistant = messages.find((message) => hasToolUse([message], "c1"))
    const types = partTypes(assistant)
    observations.reasonUnsigned = types
    const thinking = (assistant?.content ?? []).filter((part) => part?.type === "thinking")
    if (thinking.length > 1) failures.push(`reason-bad: plugin added an extra thinking block (${thinking.length})`)
  }

  const orphanReceipt = results[ORPHAN]?.receipt
  if (!(orphanReceipt && Number(orphanReceipt.toolPairs) >= 1)) failures.push("runtime did not record a durable toolPairs repair receipt")
  const pairedReceipt = results[PAIRED]?.receipt
  if (pairedReceipt && (Number(pairedReceipt.toolPairs) >= 1 || pairedReceipt.prefill === true)) {
    failures.push("paired case recorded an unexpected repair receipt")
  }
  const prefillReceipt = results[PREFILL]?.receipt
  if (!(prefillReceipt && prefillReceipt.prefill === true)) failures.push("runtime did not record a durable prefill repair receipt")

  const v1After = snapshotV1()
  const v1Intact = v1Before.configHash === v1After.configHash && v1Before.configFiles === v1After.configFiles && v1Before.shareFiles === v1After.shareFiles

  const report = {
    modelID,
    cases: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, { idle: value.idle, bodies: value.bodies.length, receipt: value.receipt }])),
    observations,
    runtimeRepairLog: repairLines,
    failures,
    v1: { before: v1Before, after: v1After, intact: v1Intact },
  }
  fs.writeFileSync(path.join(evidenceDir, "T27-result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))

  if (failures.length > 0) {
    console.error(`T27 live experiment FAILED: ${failures.length} assertion(s)`)
    process.exit(1)
  }
  if (!v1Intact) {
    console.error("T27 live experiment FAILED: V1 snapshot changed")
    process.exit(1)
  }
  console.log("T27 live experiment PASSED (lab-only; loopback provider captured the repaired tool pair and prefill; reasoning observed as native V2; V1 intact)")
}

main().catch((error) => {
  console.error(`T27 live experiment error: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
