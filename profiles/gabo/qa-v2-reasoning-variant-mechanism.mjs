#!/usr/bin/env node
/**
 * Reasoning/variant binary-surface experiment harness (lab-only).
 *
 * Answers, with raw provider-body captures, which V2 surface carries
 * variant/reasoning behavior to the provider:
 *   E3/E4: does selecting a model variant make V2 apply its `settings`?
 *   E6:    which camelCase option key reaches the wire (reasoning vs thinking)?
 *   E1/E5: (probe mode) does a `context` hook writing `event.options.*` reach the
 *          provider, per model call, with unrelated turns unmutated?
 *
 * Isolation: addresses ONLY 127.0.0.1:4098/4099 (own mocks) and 4097 (the lab).
 * The refresh script stops/starts ONLY opencode-v2-lab.service; V1
 * (opencode-lan.service) is never touched. No Docker. No direct opencode spawn.
 *
 * Run: node profiles/gabo/qa-v2-reasoning-variant-mechanism.mjs [--focus=E3,E4,E6]
 */
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const worktreeRoot = path.resolve(here, "../..")

// When this runs from a task worktree (`<main>/.local-ignore/worktrees/<task>`),
// the canonical checkout is the worktree root's great-grandparent; otherwise the
// repo root IS the canonical checkout. No machine-specific path is hardcoded.
function resolveMainRoot(repoRoot) {
  const marker = `${path.sep}.local-ignore${path.sep}worktrees${path.sep}`
  const index = repoRoot.indexOf(marker)
  return index === -1 ? repoRoot : repoRoot.slice(0, index)
}
const mainRoot = process.env.RIGEL_V2_MAIN_ROOT || resolveMainRoot(worktreeRoot)
const refreshRoot = process.env.RIGEL_V2_REFRESH_ROOT === "worktree" ? worktreeRoot : mainRoot
const evidenceDir = process.env.RIGEL_REASONING_QA_EVIDENCE_DIR
  || path.join(worktreeRoot, ".omo/evidence/20261006-t23-think-variants/experiments")
const labRoot = path.join(os.homedir(), ".local/share/opencode-v2-lab")
const labConfig = path.join(labRoot, "config/opencode/opencode.json")
const secretFile = path.join(labRoot, "secret.env")
const proxyPort = 4098
const fixturePort = 4099
const labPort = 4097
const labUrl = `http://127.0.0.1:${labPort}`
const PROBE_FILE = "/tmp/rigel-reasoning-probe.json"
const PROBE_MARKER = "REASONINGPROBE"

function readPassword() {
  const text = fs.readFileSync(secretFile, "utf8")
  const line = text.split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  return line ? line.slice("OPENCODE_PASSWORD=".length).trim() : ""
}
const password = readPassword()
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

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

// V1 is live production: content-hashing its 5GB sqlite/log tree is unsafe and
// churn-prone. Mirror run-lab-acceptance.sh: file COUNTS plus a hash of the
// stable top-level V1 config files. The authoritative gate is run-lab-acceptance.
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

function waitFor(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try { if (await check()) return resolve() } catch { /* starting */ }
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(attempt, 200)
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

async function waitIdleLab(sessionID, timeout = 30_000) {
  try {
    await fetch(`${labUrl}/api/experimental/session/${sessionID}/wait`, {
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

function startCaptureProxy(targetPort, captureLog) {
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    if (raw.length > 0 && raw.length <= 4_000_000) {
      try { captureLog.push({ path: request.url, method: request.method, body: JSON.parse(raw.toString("utf8")) }) }
      catch { captureLog.push({ path: request.url, method: request.method, raw: raw.toString("utf8").slice(0, 4000) }) }
    } else if (raw.length > 4_000_000) {
      captureLog.push({ path: request.url, method: request.method, truncated: true, size: raw.length })
    }
    const upstream = http.request({ host: "127.0.0.1", port: targetPort, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${targetPort}` } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on("error", (error) => { try { response.writeHead(502).end(String(error)) } catch { /* closed */ } })
    upstream.end(raw)
  })
  return new Promise((resolve) => server.listen(proxyPort, "127.0.0.1", () => resolve(server)))
}

function primaryRequests(captureLog, fromIndex, marker) {
  return captureLog.slice(fromIndex).filter((entry) => {
    const text = JSON.stringify(entry)
    return entry?.path === "/v1/chat/completions" && text.includes(marker)
  })
}

function describeBody(body) {
  if (!body || typeof body !== "object") return { raw: String(body).slice(0, 400) }
  const out = { model: body.model ?? null, keys: Object.keys(body).sort() }
  for (const key of ["reasoning", "reasoning_effort", "reasoningEffort", "thinking", "text", "text_verbosity", "textVerbosity", "verbosity", "max_tokens", "maxTokens", "temperature", "top_p", "topP"]) {
    if (key in body) out[key] = body[key]
  }
  return out
}

async function runScenario({ name, variant, promptText, captureLog, agent }) {
  const created = await labApi("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: worktreeRoot }, ...(agent ? { agent } : {}) }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error(`session create failed: ${JSON.stringify(created).slice(0, 200)}`)
  const model = { providerID: "rigel-loopback", id: "qa-mock-model", ...(variant !== undefined ? { variant } : {}) }
  let switchResult = "ok"
  try {
    await labApi(`/api/session/${sessionID}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    })
  } catch (error) {
    switchResult = `error: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`
  }
  const infoBefore = await labApi(`/api/session/${sessionID}`).catch(() => null)
  const from = captureLog.length
  let promptError = null
  try {
    await labApi(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: promptText, resume: true }),
    })
  } catch (error) {
    promptError = error instanceof Error ? error.message.slice(0, 300) : String(error)
  }
  const idle = await waitIdleLab(sessionID)
  const all = captureLog.slice(from)
  const requests = primaryRequests(captureLog, from, promptText)
  const bodies = requests.map((entry) => describeBody(entry.body))
  return {
    name, sessionID, variant: variant ?? null, switchResult, promptError, idle,
    requestCount: requests.length, bodies, rawBodies: requests.map((entry) => entry.body),
    sessionInfo: infoBefore ? JSON.stringify(infoBefore).slice(0, 1500) : null,
    captures: all.map((entry) => ({ path: entry.path, method: entry.method, size: JSON.stringify(entry).length })),
    rawCaptures: all.map((entry) => entry.body ?? { truncated: entry.truncated, path: entry.path }),
  }
}

async function runIsolationScenario(captureLog, { mode = "iso", turn1 = `first ${PROBE_MARKER}`, turn2 = "second plain turn", agent } = {}) {
  const created = await labApi("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: worktreeRoot }, ...(agent ? { agent } : {}) }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error("iso session create failed")
  await labApi(`/api/session/${sessionID}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "rigel-loopback", id: "qa-mock-model" } }),
  })
  if (mode) fs.writeFileSync(PROBE_FILE, JSON.stringify({ mode }))
  const from = captureLog.length
  await labApi(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: turn1, resume: true }) })
  const idle1 = await waitIdleLab(sessionID)
  const mid = captureLog.length
  await labApi(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: turn2, resume: true }) })
  const idle2 = await waitIdleLab(sessionID)
  const describe = (entries) => entries
    .filter((entry) => entry?.path === "/v1/chat/completions")
    .map((entry) => ({ ...describeBody(entry.body), hasMarker: JSON.stringify(entry.body).includes(PROBE_MARKER), hasTools: Array.isArray(entry.body?.tools) }))
  return { name: "iso-two-turn", sessionID, idle1, idle2, turn1: describe(captureLog.slice(from, mid)), turn2: describe(captureLog.slice(mid)) }
}

async function main() {
  const focus = (process.argv.find((arg) => arg.startsWith("--focus="))?.slice("--focus=".length) ?? "E3,E4,E6").split(",").map((item) => item.trim()).filter(Boolean)
  const useProbe = ["E1", "E2", "E6"].some((key) => focus.includes(key))
  fs.mkdirSync(evidenceDir, { recursive: true })
  const v1Before = snapshotV1()
  console.error(`[reasoning-qa] V1 before: config#${v1Before.configFiles} cfgHash=${v1Before.configHash.slice(0, 12)} share#${v1Before.shareFiles}`)
  if (fs.readFileSync(labConfig, "utf8").includes("rigel-loopback")) throw new Error("lab config still carries a previous rigel-loopback edit; aborting")
  const backupPath = `${labConfig}.bak-reasoning-${Date.now()}`
  fs.copyFileSync(labConfig, backupPath)

  const fixtureEnv = {
    ...process.env,
    RIGEL_FAKE_MODEL_PORT: String(fixturePort),
    RIGEL_FAKE_MODEL_TRACE: path.join(evidenceDir, "fixture-trace.jsonl"),
    RIGEL_FAKE_PARENT_REPLY: "REASONING_MOCK_REPLY_OK",
  }
  const fixture = childProcess.spawn(process.execPath, [path.join(mainRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] })
  let fixtureErr = ""
  fixture.stderr.on("data", (data) => { fixtureErr += data.toString() })
  const captureLog = []
  const proxy = await startCaptureProxy(fixturePort, captureLog)
  console.error(`[reasoning-qa] capture proxy :${proxyPort} -> fixture :${fixturePort}`)

  let restored = false
  const restoreLab = async () => {
    if (restored) return
    restored = true
    fs.copyFileSync(backupPath, labConfig)
    fs.rmSync(backupPath, { force: true })
    fs.rmSync(PROBE_FILE, { force: true })
    // Always restore the CANONICAL (main) runtime, never a probe/worktree copy.
    childProcess.spawnSync("bash", [path.join(mainRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: mainRoot, stdio: "inherit", timeout: 300_000 })
  }

  const results = {}
  try {
    const config = JSON.parse(fs.readFileSync(labConfig, "utf8"))
    config.provider["rigel-loopback"] = {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${proxyPort}/v1`, apiKey: "rigel-loopback-no-secret" },
      models: {
        "qa-mock-model": {
          name: "Reasoning QA mock",
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1000000, output: 8192 },
        },
      },
    }
    config.model = "rigel-loopback/qa-mock-model"
    config.small_model = "rigel-loopback/qa-mock-model"
    if (useProbe) config.plugin = [...(config.plugin ?? []), path.join(evidenceDir, "probe-plugin")]
    fs.writeFileSync(labConfig, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
    console.error(`[reasoning-qa] refresh root=${refreshRoot}`)
    const refresh = childProcess.spawnSync("bash", [path.join(refreshRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: refreshRoot, stdio: "inherit", timeout: 300_000 })
    if (refresh.status !== 0) throw new Error(`lab refresh failed with status ${refresh.status}`)
    await waitFor(async () => {
      try {
        const response = await fetch(`${labUrl}/api/info`, { headers: { authorization } })
        await response.arrayBuffer()
        return response.ok
      } catch { return false }
    }, "lab did not come back", 180_000)

    try {
      const rawModels = await (await fetch(`${labUrl}/api/model`, { headers: { authorization } })).text()
      console.error(`[reasoning-qa] /api/model length=${rawModels.length} hasLoopback=${rawModels.includes("rigel-loopback")} hasQaMock=${rawModels.includes("qa-mock-model")}`)
    } catch (error) {
      console.error(`[reasoning-qa] /api/model probe failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const runProbe = async (name, mode, promptText) => {
      if (mode) fs.writeFileSync(PROBE_FILE, JSON.stringify({ mode }))
      else fs.rmSync(PROBE_FILE, { force: true })
      return runScenario({ name, variant: undefined, promptText, captureLog })
    }
    if (focus.includes("E1")) results.controlNoProbe = await runProbe("control-no-probe", null, `control ${PROBE_MARKER}`)
    if (focus.includes("E1")) results.probeCamel = await runProbe("probe-camel", "camel", `camel ${PROBE_MARKER}`)
    if (focus.includes("E1")) results.probeSnake = await runProbe("probe-snake", "snake", `snake ${PROBE_MARKER}`)
    if (focus.includes("E6")) results.probeThink = await runProbe("probe-think", "think", `think ${PROBE_MARKER}`)
    if (focus.includes("E2")) results.probeModelRequestVariant = await runProbe("probe-mr-variant", "mr-variant", `mr ${PROBE_MARKER}`)
    if (focus.includes("E5")) results.isolation = await runIsolationScenario(captureLog)
    if (focus.includes("MUT")) {
      results.mutationThink = await runScenario({ name: "mutation-think", agent: "Prometheus - Plan Builder", promptText: `please think about ${PROBE_MARKER}`, captureLog })
    }
    if (focus.includes("LIVE")) {
      const PLAIN = "Prometheus - Plan Builder"
      results.liveAgentReasoning = await runScenario({ name: "live-agent-reasoning", promptText: `hello ${PROBE_MARKER}`, captureLog })
      results.liveControl = await runScenario({ name: "live-control-plain", agent: PLAIN, promptText: `hello ${PROBE_MARKER}`, captureLog })
      results.liveThink = await runScenario({ name: "live-think-plain", agent: PLAIN, promptText: `please think about ${PROBE_MARKER}`, captureLog })
      results.liveCodeBlock = await runScenario({ name: "live-code-block", agent: PLAIN, promptText: "```\nthink\n```\nhello " + PROBE_MARKER, captureLog })
      results.liveIsolation = await runIsolationScenario(captureLog, { mode: null, agent: PLAIN, turn1: `think ${PROBE_MARKER}`, turn2: "second plain turn" })
    }

    const artifacts = {}
    for (const [key, value] of Object.entries(results)) {
      if (key.startsWith("_")) continue
      const file = path.join(evidenceDir, `E-${key}.json`)
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
      artifacts[key] = { file, sha256: sha256(fs.readFileSync(file)) }
    }
    fs.writeFileSync(path.join(evidenceDir, "E-capture-manifest.json"), JSON.stringify({ refreshRoot, artifacts, fixtureError: fixtureErr.slice(0, 2000) }, null, 2) + "\n", { mode: 0o600 })
    console.log(JSON.stringify({ refreshRoot, scenarios: Object.keys(results).filter((key) => !key.startsWith("_")), artifacts }, null, 2))
  } finally {
    proxy.close()
    fixture.kill("SIGTERM")
    await restoreLab()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const v1After = snapshotV1()
    const intact = v1Before.configHash === v1After.configHash && v1Before.configFiles === v1After.configFiles
    fs.writeFileSync(path.join(evidenceDir, "E-v1-integrity.json"), JSON.stringify({
      before: v1Before,
      after: v1After,
      intact,
      note: "method mirrors run-lab-acceptance.sh (file counts + stable config hash); live V1 share churn is not a violation. Authoritative gate: run-lab-acceptance.sh --refresh.",
    }, null, 2) + "\n", { mode: 0o600 })
    console.error(`[reasoning-qa] V1 after: config#${v1After.configFiles} cfgHash=${v1After.configHash.slice(0, 12)} share#${v1After.shareFiles} intact=${intact}`)
    if (!intact) {
      console.error("[reasoning-qa] V1 INTEGRITY VIOLATION - stop, report immediately")
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
