#!/usr/bin/env node
/**
 * T31 live experiment (lab-only): prove the two surface walls on the real V2
 * laboratory (`opencode-v2-lab.service`, port 4097).
 *
 * (a) auto-update-checker effect: the runtime queries a simulated npm registry
 *     at startup and injects a notice into the provider request's system text
 *     when a newer version is published. It never installs anything.
 *       - POSITIVE: a registry serving v2.0.0 while the runtime reports v1.0.0
 *         produces the notice in the captured provider body; the registry is hit
 *         exactly once across several sessions (at most one check per day).
 *       - EQUAL: a registry serving the running version produces no notice.
 *       - NETWORK FAILURE: an unreachable registry produces no notice and a
 *         durable receipt whose outcome is `failed`.
 * (b) tool-definition effect: the captured tool schema carries `todowrite` with
 *     the exact V1 TODOWRITE_DESCRIPTION, and no host tool is mutated (no other
 *     tool carries that description).
 *
 * Isolation: addresses only 127.0.0.1 (its own loopback ports and lab 4097). The
 * refresh stops/starts ONLY opencode-v2-lab.service via
 * apply-v2-runtime-service.sh. V1 is read-only and its config hash plus root
 * file counts are compared before and after. No Docker, no direct opencode
 * launch. When the lab is unreachable it declares SKIP with the reason.
 *
 * Usage: node profiles/gabo/qa-v2-t31-surface-walls.mjs
 */
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { TODOWRITE_DESCRIPTION } from "./opencode/rigel-v2-flow-logic.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const worktreeRoot = path.resolve(here, "../..")
const evidenceDir = path.join(worktreeRoot, ".omo/evidence/20261008-t31-surface-walls")
const sessionDir = path.join(os.tmpdir(), "rigel-t31-surface-walls-cwd")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const labConfig = path.join(labRoot, "config/opencode/opencode.json")
const secretFile = path.join(labRoot, "secret.env")
const receiptFile = path.join(labRoot, "state/oh-my-rigel/update-check.json")
const labManifest = path.join(labRoot, "rigel/runtime/rigel-v2-agent-manifest.mjs")
const labUrl = process.env.RIGEL_V2_LAB_URL || "http://127.0.0.1:4097"
const providerPort = Number(process.env.RIGEL_T31_PROVIDER_PORT || "41391")
const registryPort = Number(process.env.RIGEL_T31_REGISTRY_PORT || "41392")
const closedPort = Number(process.env.RIGEL_T31_CLOSED_PORT || "41393")
const AGENT = "Sisyphus - ultraworker"
const PROVIDER_ID = "rigel-t31"
const MODEL_ID = "t31-probe"
const PACKAGE_NAME = "oh-my-openagent"
const NOTICE_MARKER = "<rigel-native-update-notice>"

function skip(reason) {
  console.log(`Rigel V2 T31 surface-walls live QA: SKIP (${reason})`)
  process.exit(0)
}
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
  const goalDir = path.join(os.homedir(), ".local/share/opencode-goal-plugin")
  const cacheDir = path.join(os.homedir(), ".cache/opencode")
  const stable = []
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const file = path.join(configDir, name)
    if (fs.existsSync(file)) stable.push(`${name}:${sha256(fs.readFileSync(file))}`)
  }
  return {
    configFiles: countFiles(configDir),
    shareFiles: countFiles(shareDir),
    goalFiles: countFiles(goalDir),
    cacheFiles: countFiles(cacheDir),
    configHash: sha256(stable.join("\n")),
  }
}

if (!fs.existsSync(secretFile)) skip(`no lab credentials at ${secretFile}`)
const password = (fs.readFileSync(secretFile, "utf8").split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD=")) ?? "").slice("OPENCODE_PASSWORD=".length).trim()
if (!password) skip(`no lab password at ${secretFile}`)
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

async function waitFor(check, message, timeout = 60_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try { const value = await check(); if (value) return value } catch { /* retry */ }
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
async function labApi(pathname, init = {}) {
  const response = await fetch(`${labUrl}${pathname}`, { ...init, headers: { authorization, ...init.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}
async function waitReady(timeout = 120_000) {
  await waitFor(async () => {
    const response = await fetch(`${labUrl}/api/info`, { headers: { authorization } })
    return response.ok
  }, `lab API never became ready at ${labUrl}`, timeout)
}
async function waitIdle(sessionID, timeout = 60_000) {
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
    body: JSON.stringify({ agent: AGENT, model: { id: MODEL_ID, providerID: PROVIDER_ID }, location: { directory: sessionDir } }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error(`session create failed: ${JSON.stringify(created).slice(0, 200)}`)
  return sessionID
}
async function prompt(sessionID, text) {
  await labApi(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, resume: true }),
  })
  return waitIdle(sessionID)
}

/** Loopback OpenAI-compatible provider that records the exact body it receives. */
function startProvider() {
  const bodies = []
  const server = http.createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    let parsed
    try { parsed = JSON.parse(raw || "{}") } catch { parsed = { raw } }
    bodies.push({ url: request.url, body: parsed })
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t31", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t31", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(providerPort, "127.0.0.1", () => resolve({
      bodies,
      close: () => new Promise((done) => server.close(() => done())),
    }))
  })
}

/** Loopback npm dist-tags registry: GET any path answers `{ latest }`. */
function startRegistry(getLatest) {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ latest: getLatest(), next: getLatest() }))
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(registryPort, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${registryPort}/-/package/${PACKAGE_NAME}/dist-tags`,
      requests,
      hits: () => requests.length,
      close: () => new Promise((done) => server.close(() => done())),
    }))
  })
}

function systemText(body) {
  const parts = []
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (const message of messages) {
    if (message?.role !== "system") continue
    if (typeof message.content === "string") parts.push(message.content)
    else if (Array.isArray(message.content)) parts.push(message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(""))
  }
  if (typeof body?.system === "string") parts.push(body.system)
  if (typeof body?.instructions === "string") parts.push(body.instructions)
  return parts.join("\n")
}

/** name -> description map from both chat-completions and responses tool shapes. */
function toolDescriptions(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const map = new Map()
  for (const entry of tools) {
    const fn = entry?.function ?? entry
    const name = typeof fn?.name === "string" ? fn.name : undefined
    if (!name) continue
    map.set(name, typeof fn?.description === "string" ? fn.description : "")
  }
  return map
}

function refreshLab() {
  const env = { ...process.env }
  delete env.RIGEL_V2_PROFILE_FILE
  return childProcess.spawnSync("bash", [path.join(worktreeRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: worktreeRoot, env, stdio: "inherit", timeout: 300_000 })
}
function setLabEnv(overrides) {
  const lines = fs.readFileSync(secretFile, "utf8").split("\n")
    .filter((line) => !/^RIGEL_UPDATE_[A-Z_]*=/.test(line))
  for (const [key, value] of Object.entries(overrides)) lines.push(`${key}=${value}`)
  fs.writeFileSync(secretFile, `${lines.filter((line) => line !== "").join("\n")}\n`, { mode: 0o600 })
}
function addProviderToLabConfig(original) {
  const config = JSON.parse(original)
  config.provider = config.provider ?? {}
  config.provider[PROVIDER_ID] = {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-t31-no-secret" },
    models: {
      [MODEL_ID]: { name: "T31 probe", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1_000_000, output: 8192 } },
    },
  }
  return JSON.stringify(config, null, 2) + "\n"
}
function readReceipt() {
  try { return JSON.parse(fs.readFileSync(receiptFile, "utf8")) } catch { return null }
}
function readLabManifest() {
  try { const src = fs.readFileSync(labManifest, "utf8"); return JSON.parse(src.slice(src.indexOf("{"))) } catch { return null }
}

const checks = {}
const details = {}
const failures = []
function expect(name, condition, note) {
  checks[name] = condition === true
  if (condition !== true) failures.push(`${name}${note ? ` (${note})` : ""}`)
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(sessionDir, { recursive: true })
  const v1Before = snapshotV1()
  const originalConfig = fs.readFileSync(labConfig, "utf8")
  const originalSecret = fs.readFileSync(secretFile, "utf8")
  const createdSessions = []
  let provider
  let registry
  let phaseBodies = []
  // Each run uses fresh storage keys so the daily cache does not starve a
  // second run on the same day; the cache itself is proven by registryHits===1.
  const runStamp = `${Date.now()}`
  const runPhase = async ({ key, current, registryUrl, label, sessionCount }) => {
    setLabEnv({
      RIGEL_UPDATE_REGISTRY_URL: registryUrl,
      RIGEL_UPDATE_PACKAGE: PACKAGE_NAME,
      RIGEL_UPDATE_CURRENT_VERSION: current,
      RIGEL_UPDATE_STATE_KEY: key,
    })
    fs.rmSync(receiptFile, { force: true })
    const refresh = refreshLab()
    if (refresh.status !== 0) throw new Error(`lab refresh (${label}) failed with status ${refresh.status}`)
    await waitReady()
    const before = provider.bodies.length
    // Warm-up: V2 loads a local plugin lazily on the first turn, so the plugin's
    // update check starts here rather than on the measured request.
    const warm = await newSession()
    createdSessions.push(warm)
    await prompt(warm, `T31 warm ${label}`)
    const measured = []
    const idles = []
    for (let index = 0; index < sessionCount; index += 1) {
      const sessionID = await newSession()
      createdSessions.push(sessionID)
      idles.push(await prompt(sessionID, `T31 measured ${label} ${index}`))
      measured.push(sessionID)
    }
    phaseBodies = provider.bodies.slice(before).map((entry) => entry.body)
    return { bodies: phaseBodies, measured, idles }
  }
  try {
    provider = await startProvider()
    fs.writeFileSync(labConfig, addProviderToLabConfig(originalConfig), { mode: 0o600 })

    // --- POSITIVE + daily cache: registry newer than the running version ---
    registry = await startRegistry(() => "2.0.0")
    const positive = await runPhase({ key: `t31-pos-${runStamp}`, current: "1.0.0", registryUrl: registry.url, label: "positive", sessionCount: 2 })
    const positiveSystems = positive.bodies.map(systemText)
    expect("notice.present", positiveSystems.some((text) => text.includes(NOTICE_MARKER)), "no captured root body carried the notice marker")
    expect("notice.mentionsLatest", positiveSystems.some((text) => text.includes("2.0.0")), "notice did not mention the published version")
    expect("registry.singleCheck", registry.hits() === 1, `registry hit ${registry.hits()} times; expected exactly one check per day`)
    details.positive = { registryHits: registry.hits(), bodies: positive.bodies.length }

    // --- Identity: the manifest materializes the bundled build version ---
    const materializedVersion = readLabManifest()?.metadata?.global?.bundledVersion
    const rootVersion = JSON.parse(fs.readFileSync(path.join(worktreeRoot, "package.json"), "utf8")).version
    expect("manifest.bundledVersion", typeof materializedVersion === "string" && materializedVersion === rootVersion, `bundledVersion=${JSON.stringify(materializedVersion)} root=${rootVersion}`)
    details.manifest = { bundledVersion: materializedVersion ?? null, rootVersion }

    // --- Tool-definition effect observed on the same captured bodies ---
    const withTools = positive.bodies.find((body) => toolDescriptions(body).size > 0)
    const tools = withTools ? toolDescriptions(withTools) : new Map()
    const todoDescription = tools.get("todowrite")
    expect("tool.todowritePresent", typeof todoDescription === "string", "todowrite missing from the captured tool schema")
    expect("tool.todowriteOverridden", todoDescription === TODOWRITE_DESCRIPTION, "todowrite description is not the exact V1 text")
    const leaked = [...tools.entries()].filter(([name, description]) => name !== "todowrite" && description === TODOWRITE_DESCRIPTION)
    expect("tool.noHostMutation", leaked.length === 0, `the V1 description leaked into host tools: ${leaked.map(([name]) => name).join(",")}`)
    details.tools = { count: tools.size, distinctOverride: todoDescription === TODOWRITE_DESCRIPTION, leaked: leaked.map(([name]) => name) }

    if (registry?.close) await registry.close()

    // --- EQUAL: registry serves the running version ---
    registry = await startRegistry(() => "1.0.0")
    await runPhase({ key: `t31-eq-${runStamp}`, current: "1.0.0", registryUrl: registry.url, label: "equal", sessionCount: 1 })
    const equalSystems = phaseBodies.map(systemText)
    expect("equal.noNotice", !equalSystems.some((text) => text.includes(NOTICE_MARKER)), "an equal version produced a notice")
    expect("equal.registryHit", registry.hits() >= 1, "the equal-version scenario never reached the registry")
    details.equal = { registryHits: registry.hits(), bodies: phaseBodies.length }
    if (registry?.close) await registry.close()
    registry = undefined

    // --- NETWORK FAILURE: registry unreachable ---
    const failurePhase = await runPhase({ key: `t31-fail-${runStamp}`, current: "1.0.0", registryUrl: `http://127.0.0.1:${closedPort}/-/package/${PACKAGE_NAME}/dist-tags`, label: "network-failure", sessionCount: 1 })
    const failureSystems = phaseBodies.map(systemText)
    expect("failure.noNotice", !failureSystems.some((text) => text.includes(NOTICE_MARKER)), "a failed registry produced a notice")
    const receipt = readReceipt()
    expect("failure.receipt", receipt?.outcome === "failed", `receipt outcome was ${JSON.stringify(receipt?.outcome)}`)
    // Non-blocking: the measured turn still reached the provider while the
    // registry was unreachable, so the check never gated the session.
    expect("failure.nonBlocking", failurePhase.bodies.length > 0, "the session never reached the provider with the registry unreachable")
    details.failure = { bodies: failurePhase.bodies.length, idles: failurePhase.idles, receiptOutcome: receipt?.outcome ?? null }
  } finally {
    if (provider?.close) await provider.close().catch(() => {})
    if (registry?.close) await registry.close().catch(() => {})
    // Restore the lab to the real profile and environment.
    fs.writeFileSync(labConfig, originalConfig, { mode: 0o600 })
    fs.writeFileSync(secretFile, originalSecret, { mode: 0o600 })
    refreshLab()
    await waitReady().catch(() => {})
    for (const sessionID of createdSessions) await labApi(`/api/session/${sessionID}`, { method: "DELETE" }).catch(() => {})
  }

  const v1After = snapshotV1()
  expect("v1.configUnchanged", v1Before.configHash === v1After.configHash, "V1 config hash changed")
  expect("v1.fileCountsUnchanged",
    v1Before.configFiles === v1After.configFiles &&
    v1Before.shareFiles === v1After.shareFiles &&
    v1Before.goalFiles === v1After.goalFiles &&
    v1Before.cacheFiles === v1After.cacheFiles,
    "a V1 root file count changed")
  details.v1Before = v1Before
  details.v1After = v1After

  const report = { labUrl, providerPort, registryPort, checks, details, failures, at: new Date().toISOString() }
  fs.writeFileSync(path.join(evidenceDir, "t31-live-qa.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ checks, details, failures }, null, 2))
  if (failures.length > 0) {
    console.error(`Rigel V2 T31 surface-walls live QA FAILED: ${failures.join(", ")}`)
    process.exit(1)
  }
  console.log("Rigel V2 T31 surface-walls live QA PASS (update notice via simulated registry, daily cache, network failure receipt, observable tool definition; V1 intact)")
}

await main()
