#!/usr/bin/env node
/**
 * Anthropic reasoning-adapter experiment (lab-only).
 *
 * Routes the REAL V2 Anthropic provider at a local Messages-API mock by
 * overriding `provider.anthropic.options.baseURL`, then captures the FINAL wire
 * body for a control turn, a think-keyword turn, and a two-turn isolation run.
 * This observes the provider transform instead of asserting an OpenAI-compatible
 * proxy shape.
 *
 * Isolation: addresses only 127.0.0.1:4098/4099 (own mocks) and 4097 (the lab).
 * Refresh stops/starts ONLY opencode-v2-lab.service; V1 is read-only. No Docker.
 *
 * Run: RIGEL_V2_REFRESH_ROOT=worktree node profiles/gabo/qa-v2-reasoning-anthropic.mjs
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
function resolveMainRoot(repoRoot) {
  const marker = `${path.sep}.local-ignore${path.sep}worktrees${path.sep}`
  const index = repoRoot.indexOf(marker)
  return index === -1 ? repoRoot : repoRoot.slice(0, index)
}
const mainRoot = process.env.RIGEL_V2_MAIN_ROOT || resolveMainRoot(worktreeRoot)
const refreshRoot = process.env.RIGEL_V2_REFRESH_ROOT === "main" ? mainRoot : worktreeRoot
const evidenceDir = path.join(worktreeRoot, ".omo/evidence/20261006-t23-think-variants/experiments")
const labRoot = path.join(os.homedir(), ".local/share/opencode-v2-lab")
const labConfig = path.join(labRoot, "config/opencode/opencode.json")
const secretFile = path.join(labRoot, "secret.env")
const proxyPort = 4098
const fixturePort = 4099
const labPort = 4097
const labUrl = `http://127.0.0.1:${labPort}`
const marker = "ANTHROPICPROBE"
const anthropicModel = process.env.RIGEL_ANTHROPIC_MODEL || "anthropic/claude-sonnet-4-5"
const plainAgent = "Prometheus - Plan Builder"
const probeFile = "/tmp/rigel-reasoning-probe.json"

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

function startCaptureProxy(targetPort, captureLog) {
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const url = request.url ?? ""
    if (raw.length > 0 && raw.length <= 4_000_000) {
      try { captureLog.push({ path: url, method: request.method, body: JSON.parse(raw.toString("utf8")) }) }
      catch { captureLog.push({ path: url, method: request.method, raw: raw.toString("utf8").slice(0, 2000) }) }
    }
    const upstream = http.request({ host: "127.0.0.1", port: targetPort, path: url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${targetPort}` } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on("error", (error) => { try { response.writeHead(502).end(String(error)) } catch { /* closed */ } })
    upstream.end(raw)
  })
  return new Promise((resolve) => server.listen(proxyPort, "127.0.0.1", () => resolve(server)))
}

function describeAnthropic(body) {
  if (!body || typeof body !== "object") return { raw: String(body).slice(0, 200) }
  return {
    model: body.model ?? null,
    stream: body.stream ?? null,
    max_tokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
    thinking: body.thinking ?? null,
    output_config: body.output_config ?? null,
    reasoning: body.reasoning ?? null,
    reasoning_effort: body.reasoning_effort ?? null,
    reasoningEffort: body.reasoningEffort ?? null,
    keys: Object.keys(body).sort(),
  }
}

function anthropicBodies(captureLog, from) {
  return captureLog.slice(from).filter((entry) => typeof entry.path === "string" && entry.path.includes("/messages") && !entry.path.includes("count_tokens"))
}

async function newSession(agent) {
  const created = await labApi("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: worktreeRoot }, ...(agent ? { agent } : {}) }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error(`session create failed: ${JSON.stringify(created).slice(0, 200)}`)
  return sessionID
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const v1Before = snapshotV1()
  console.error(`[anthropic-qa] V1 before: config#${v1Before.configFiles} cfgHash=${v1Before.configHash.slice(0, 12)} share#${v1Before.shareFiles}`)
  if (fs.readFileSync(labConfig, "utf8").includes('"baseURL": "http://127.0.0.1:4098/v1"')) throw new Error("lab config already carries a loopback anthropic edit; aborting")
  const backupPath = `${labConfig}.bak-anthropic-${Date.now()}`
  fs.copyFileSync(labConfig, backupPath)

  const fixtureEnv = {
    ...process.env,
    RIGEL_FAKE_MODEL_PORT: String(fixturePort),
    RIGEL_FAKE_MODEL_TRACE: path.join(evidenceDir, "anthropic-fixture-trace.jsonl"),
    RIGEL_FAKE_ANTHROPIC_REPLY: "ANTHROPIC_FIXTURE_OK",
  }
  const fixture = childProcess.spawn(process.execPath, [path.join(worktreeRoot, "profiles/gabo/fixtures/fake-anthropic-messages.mjs")], { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] })
  let fixtureErr = ""
  fixture.stderr.on("data", (data) => { fixtureErr += data.toString() })
  const captureLog = []
  const proxy = await startCaptureProxy(fixturePort, captureLog)
  console.error(`[anthropic-qa] capture proxy :${proxyPort} -> anthropic fixture :${fixturePort}`)

  let restored = false
  const restoreLab = async () => {
    if (restored) return
    restored = true
    fs.copyFileSync(backupPath, labConfig)
    fs.rmSync(backupPath, { force: true })
    childProcess.spawnSync("bash", [path.join(mainRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: mainRoot, stdio: "inherit", timeout: 300_000 })
  }

  const results = {}
  try {
    const config = JSON.parse(fs.readFileSync(labConfig, "utf8"))
    config.disabled_providers = (config.disabled_providers ?? []).filter((entry) => entry !== "anthropic")
    config.provider = config.provider ?? {}
    config.provider.anthropic = {
      ...(config.provider.anthropic ?? {}),
      options: { ...(config.provider.anthropic?.options ?? {}), baseURL: `http://127.0.0.1:${proxyPort}/v1`, apiKey: "sk-ant-mock" },
    }
    config.model = anthropicModel
    config.small_model = anthropicModel
    config.plugin = [...(config.plugin ?? []), path.join(evidenceDir, "probe-plugin")]
    fs.writeFileSync(labConfig, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
    console.error(`[anthropic-qa] refresh root=${refreshRoot}; model=${anthropicModel}`)
    const refresh = childProcess.spawnSync("bash", [path.join(refreshRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: refreshRoot, stdio: "inherit", timeout: 300_000 })
    if (refresh.status !== 0) throw new Error(`lab refresh failed with status ${refresh.status}`)
    await waitFor(async () => {
      try { const response = await fetch(`${labUrl}/api/info`, { headers: { authorization } }); await response.arrayBuffer(); return response.ok } catch { return false }
    }, "lab did not come back", 180_000)

    // control: plain agent, no keyword
    {
      const sessionID = await newSession(plainAgent)
      const from = captureLog.length
      await labApi(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `hello ${marker}`, resume: true }) })
      const idle = await waitIdleLab(sessionID)
      const bodies = anthropicBodies(captureLog, from)
      results.control = { sessionID, idle, count: bodies.length, bodies: bodies.map((entry) => describeAnthropic(entry.body)), rawBodies: bodies.map((entry) => entry.body) }
    }
    // think: plain agent, keyword in current turn
    {
      const sessionID = await newSession(plainAgent)
      const from = captureLog.length
      await labApi(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `please think about ${marker}`, resume: true }) })
      const idle = await waitIdleLab(sessionID)
      const bodies = anthropicBodies(captureLog, from)
      results.think = { sessionID, idle, count: bodies.length, bodies: bodies.map((entry) => describeAnthropic(entry.body)), rawBodies: bodies.map((entry) => entry.body) }
    }
    // isolation: two turns, keyword only in turn 1
    {
      const sessionID = await newSession(plainAgent)
      const from = captureLog.length
      await labApi(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `think ${marker}`, resume: true }) })
      const idle1 = await waitIdleLab(sessionID)
      const mid = captureLog.length
      await labApi(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "second plain turn", resume: true }) })
      const idle2 = await waitIdleLab(sessionID)
      const turn1 = anthropicBodies(captureLog, from).filter((entry) => captureLog.indexOf(entry) < mid)
      const turn2 = captureLog.slice(mid).filter((entry) => typeof entry.path === "string" && entry.path.includes("/messages") && !entry.path.includes("count_tokens"))
      results.isolation = {
        sessionID, idle1, idle2,
        turn1: turn1.map((entry) => describeAnthropic(entry.body)),
        turn2: turn2.map((entry) => describeAnthropic(entry.body)),
        turn1Raw: turn1.map((entry) => entry.body),
        turn2Raw: turn2.map((entry) => entry.body),
      }
    }

    // option-mode probes: which semantic option does the Anthropic adapter honor?
    for (const mode of ["camel", "snake", "think", "effort", "multi"]) {
      fs.writeFileSync(probeFile, JSON.stringify({ mode, requireMarker: false }))
      const sessionID = await newSession(plainAgent)
      const from = captureLog.length
      await labApi(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `mode ${mode}`, resume: true }) })
      const idle = await waitIdleLab(sessionID)
      const bodies = anthropicBodies(captureLog, from)
      results[`probe-${mode}`] = { sessionID, idle, count: bodies.length, bodies: bodies.map((entry) => describeAnthropic(entry.body)), rawBodies: bodies.map((entry) => entry.body) }
    }
    fs.rmSync(probeFile, { force: true })

    const artifacts = {}
    for (const [key, value] of Object.entries(results)) {
      const file = path.join(evidenceDir, `ANTHROPIC-${key}.json`)
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
      artifacts[key] = { file, sha256: sha256(fs.readFileSync(file)) }
    }
    fs.writeFileSync(path.join(evidenceDir, "ANTHROPIC-manifest.json"), JSON.stringify({ refreshRoot, model: anthropicModel, artifacts, fixtureError: fixtureErr.slice(0, 2000) }, null, 2) + "\n", { mode: 0o600 })
    console.log(JSON.stringify({ model: anthropicModel, scenarios: Object.keys(results), artifacts }, null, 2))
  } finally {
    proxy.close()
    fixture.kill("SIGTERM")
    await restoreLab()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const v1After = snapshotV1()
    const intact = v1Before.configHash === v1After.configHash && v1Before.configFiles === v1After.configFiles
    fs.writeFileSync(path.join(evidenceDir, "ANTHROPIC-v1-integrity.json"), JSON.stringify({ before: v1Before, after: v1After, intact }, null, 2) + "\n", { mode: 0o600 })
    console.error(`[anthropic-qa] V1 after: config#${v1After.configFiles} cfgHash=${v1After.configHash.slice(0, 12)} share#${v1After.shareFiles} intact=${intact}`)
    if (!intact) { console.error("[anthropic-qa] V1 INTEGRITY VIOLATION - stop"); process.exitCode = 1 }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
