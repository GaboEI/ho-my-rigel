#!/usr/bin/env node
/**
 * T29 live experiment (lab-only): prove the native V2 bidirectional OpenClaw
 * surface end to end on the real lab (`opencode-v2-lab.service`, port 4097).
 *
 * The recovered unit suites prove the pure halves and the composition in
 * isolation. This experiment proves the two effects on the real surface:
 *
 *   - OUTBOUND: a real session event is dispatched to a loopback HTTP gateway,
 *     and the exact payload the gateway received is recorded (event,
 *     instruction, sessionId, context) rather than claimed.
 *   - INBOUND: a loopback Discord server answers with a reply quoting the
 *     outbound message id for the measured session; the runtime's reply listener
 *     resolves the correlation and injects the reply into that SAME session
 *     through the internal prompt gate. The injected user message is read back
 *     from the real session transcript.
 *   - NEGATIVE: with the real profile (no `openclaw` block) the manifest carries
 *     no OpenClaw config, no dispatch reaches the loopback gateway and no poll
 *     reaches the loopback Discord server.
 *
 * V2 loads a local plugin lazily on the first session turn, so the experiment
 * warms the plugin with an unmeasured session before the measured one; otherwise
 * the measured `session.created` would fire before the plugin subscribes. V2
 * also does not emit `session.idle` (the runtime derives the idle/stop edge from
 * `session.execution.succeeded`), which the runtime's shared event loop handles.
 *
 * Isolation: addresses only 127.0.0.1 (its own loopback ports and lab 4097). The
 * refresh stops/starts ONLY opencode-v2-lab.service via
 * apply-v2-runtime-service.sh. V1 is read-only and its config hash/file count is
 * compared before and after. No Docker, no direct opencode launch.
 *
 * Run: node profiles/gabo/qa-v2-t29-openclaw.mjs
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
const evidenceDir = path.join(worktreeRoot, ".omo/evidence/20261007-t29-openclaw")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const labConfig = path.join(labRoot, "config/opencode/opencode.json")
const secretFile = path.join(labRoot, "secret.env")
const labManifest = path.join(labRoot, "rigel/runtime/rigel-v2-agent-manifest.mjs")
const realProfile = path.join(worktreeRoot, "profiles/gabo/omo.jsonc")
const labUrl = "http://127.0.0.1:4097"
const gatewayPort = Number(process.env.RIGEL_T29_GATEWAY_PORT || "41381")
const discordPort = Number(process.env.RIGEL_T29_DISCORD_PORT || "41382")
const providerPort = Number(process.env.RIGEL_T29_PROVIDER_PORT || "41383")
const AGENT = "Sisyphus - ultraworker"
const PROVIDER_ID = "rigel-t29"
const MODEL_ID = "t29-probe"
const INBOUND_TEXT = "hello from discord"

const failures = []
function fail(message) {
  failures.push(message)
  console.error(`[t29] FAIL: ${message}`)
}

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
function waitFor(check, message, timeout = 120_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    let lastFailure
    const attempt = async () => {
      try { if (await check()) return resolve() } catch (error) { lastFailure = error }
      if (Date.now() >= deadline) {
        return reject(new Error(`${message} (last check: ${lastFailure instanceof Error ? lastFailure.message : "no failure recorded"})`))
      }
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
async function waitLabReady() {
  await waitFor(async () => {
    try { const response = await fetch(`${labUrl}/api/info`, { headers: { authorization } }); await response.arrayBuffer(); return response.ok } catch { return false }
  }, "lab did not come back")
}
async function newSession() {
  const created = await labApi("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: AGENT, model: { id: MODEL_ID, providerID: PROVIDER_ID }, location: { directory: worktreeRoot } }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error(`session create failed: ${JSON.stringify(created).slice(0, 200)}`)
  return sessionID
}
async function sendPrompt(sessionID, text) {
  await labApi(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, resume: true }),
  })
}
async function waitIdle(sessionID, timeout = 60_000) {
  try {
    await fetch(`${labUrl}/api/experimental/session/${sessionID}/wait`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeout),
    })
  } catch {
    // a failed model call can end the turn early; the plugin still loaded
  }
}
async function userMessages(sessionID) {
  const body = await labApi(`/api/session/${sessionID}/message?type=user&order=asc&limit=50`)
  return JSON.stringify(body)
}
function readManifest() {
  const src = fs.readFileSync(labManifest, "utf8")
  return JSON.parse(src.slice(src.indexOf("{")))
}
function refreshLab(profileFile) {
  const env = { ...process.env }
  if (profileFile) env.RIGEL_V2_PROFILE_FILE = profileFile
  else delete env.RIGEL_V2_PROFILE_FILE
  return childProcess.spawnSync("bash", [path.join(worktreeRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: worktreeRoot, env, stdio: "inherit", timeout: 300_000 })
}

/** The loopback gateway echoes a per-session message id so the reply is unambiguous. */
function startGateway() {
  const bodies = []
  const server = http.createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    let parsed
    try { parsed = JSON.parse(raw || "{}") } catch { parsed = { raw } }
    bodies.push({ url: request.url, method: request.method, body: parsed })
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "unknown"
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ messageId: `oc-${sessionId}`, platform: "discord" }))
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(gatewayPort, "127.0.0.1", () => resolve({
      bodies,
      url: `http://127.0.0.1:${gatewayPort}/hook`,
      close: () => new Promise((done) => server.close(() => done())),
    }))
  })
}

/** The loopback Discord server answers with a reply quoting `expectedMessageId`. */
function startDiscord(getExpectedMessageId) {
  const polls = []
  const acks = []
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${discordPort}`)
    if (request.method === "PUT" && url.pathname.includes("/reactions/")) {
      acks.push(url.pathname)
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
      return
    }
    if (url.pathname.endsWith("/messages")) {
      polls.push(`${url.pathname}${url.search}`)
      const target = getExpectedMessageId()
      const payload = target
        ? [{ id: "rep-t29-1", content: INBOUND_TEXT, author: { id: "u1" }, message_reference: { message_id: target } }]
        : []
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(payload))
      return
    }
    response.writeHead(404, { "content-type": "application/json" })
    response.end("{}")
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(discordPort, "127.0.0.1", () => resolve({
      polls,
      acks,
      base: `http://127.0.0.1:${discordPort}/discord`,
      close: () => new Promise((done) => server.close(() => done())),
    }))
  })
}

function startProvider() {
  const bodies = []
  const server = http.createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    let parsed
    try { parsed = JSON.parse(raw || "{}") } catch { parsed = { raw } }
    bodies.push(parsed)
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t29", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t29", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
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

function writeQaProfile() {
  const document = JSON.parse(fs.readFileSync(realProfile, "utf8"))
  const block = document.profiles.gabo["[opencode]"]
  block.openclaw = {
    enabled: true,
    gateways: { loopback: { url: `http://127.0.0.1:${gatewayPort}/hook` } },
    hooks: {
      "session.created": { gateway: "loopback", instruction: "t29 created {{sessionId}} {{projectPath}}" },
      "session.idle": { gateway: "loopback", instruction: "t29 idle {{sessionId}} {{projectPath}}" },
    },
    replyListener: {
      discordBotToken: "qa-token",
      discordChannelId: "chan",
      authorizedDiscordUserIds: ["u1"],
      pollIntervalMs: 500,
      rateLimitPerMinute: 10,
      maxMessageLength: 500,
      includePrefix: true,
    },
  }
  const target = path.join(os.tmpdir(), "rigel-t29-omo.jsonc")
  fs.writeFileSync(target, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 })
  return target
}

function addProviderToLabConfig(original) {
  const config = JSON.parse(original)
  config.provider = config.provider ?? {}
  config.provider[PROVIDER_ID] = {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-t29-no-secret" },
    models: {
      [MODEL_ID]: { name: "T29 probe", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1_000_000, output: 8192 } },
    },
  }
  return JSON.stringify(config, null, 2) + "\n"
}

/** Load the local plugin (lazy) with an unmeasured turn before the measured one. */
async function warmPlugin() {
  const warm = await newSession()
  await sendPrompt(warm, "T29 warmup")
  await waitIdle(warm)
  return warm
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const v1Before = snapshotV1()
  const packagesByteIdentical = childProcess.spawnSync("git", ["diff", "--quiet", "--", "packages/"], { cwd: worktreeRoot }).status === 0
  console.log(`[t29] V1 before: cfgHash=${v1Before.configHash.slice(0, 12)} config#${v1Before.configFiles} share#${v1Before.shareFiles}; packages/ byte-identical=${packagesByteIdentical}`)

  const originalConfig = fs.readFileSync(labConfig, "utf8")
  const originalSecret = fs.readFileSync(secretFile, "utf8")
  const qaProfile = writeQaProfile()
  let expectedMessageId = null
  const gateway = await startGateway()
  const discord = await startDiscord(() => expectedMessageId)
  const provider = await startProvider()
  const results = { positive: {}, negative: {} }
  let restored = false

  const restoreLab = () => {
    if (restored) return
    restored = true
    fs.writeFileSync(labConfig, originalConfig, { mode: 0o600 })
    fs.writeFileSync(secretFile, originalSecret, { mode: 0o600 })
    fs.rmSync(qaProfile, { force: true })
    refreshLab(undefined)
  }

  try {
    // --- POSITIVE: enabled OpenClaw with loopback outbound + inbound ---
    fs.writeFileSync(secretFile, `${originalSecret.trimEnd()}\nRIGEL_OPENCLAW_DISCORD_API_BASE=${discord.base}\n`, { mode: 0o600 })
    fs.writeFileSync(labConfig, addProviderToLabConfig(originalConfig), { mode: 0o600 })
    console.log(`[t29] refresh with QA profile=${qaProfile}`)
    const refresh = refreshLab(qaProfile)
    if (refresh.status !== 0) throw new Error(`lab refresh (QA profile) failed with status ${refresh.status}`)
    await waitLabReady()

    const manifest = readManifest()
    const materialized = manifest?.metadata?.global?.openclaw
    results.positive.materialized = materialized ? { enabled: materialized.enabled === true, gateways: Object.keys(materialized.gateways ?? {}), hooks: Object.keys(materialized.hooks ?? {}) } : null
    if (!materialized || materialized.enabled !== true) fail("manifest did not materialize an enabled openclaw block")

    await warmPlugin()

    const sessionID = await newSession()
    expectedMessageId = `oc-${sessionID}`
    await sendPrompt(sessionID, "T29 probe")
    await waitFor(() => gateway.bodies.some((entry) => entry.body?.sessionId === sessionID), "outbound gateway payload for the measured session", 60_000)
    const captured = gateway.bodies.find((entry) => entry.body?.sessionId === sessionID)
    const payload = captured.body
    results.positive.outbound = {
      count: gateway.bodies.length,
      event: payload.event ?? null,
      instruction: payload.instruction ?? null,
      text: payload.text ?? null,
      sessionId: payload.sessionId ?? null,
      contextSessionId: payload.context?.sessionId ?? null,
      projectName: payload.projectName ?? null,
    }
    if (!["session.created", "session.idle"].includes(payload.event)) fail(`outbound payload carried an unexpected event: ${payload.event}`)
    if (payload.context?.sessionId !== sessionID) fail("outbound payload whitelisted context did not carry the session id")
    if (typeof payload.instruction !== "string" || !payload.instruction.includes(sessionID)) fail("outbound instruction was not interpolated with the session id")

    await waitFor(() => discord.polls.length > 0, "inbound discord poll", 60_000)
    await waitFor(async () => (await userMessages(sessionID)).includes(`[reply:discord] ${INBOUND_TEXT}`), "inbound reply injected into the measured session transcript", 60_000)
    results.positive.inbound = { polls: discord.polls.length, acks: discord.acks.length, injected: true }
    if (discord.acks.length === 0) fail("inbound reply was injected but never acknowledged")

    // --- NEGATIVE: real profile (no openclaw) is a strict no-op ---
    console.log("[t29] restore lab to the real profile and prove the absent-config no-op")
    fs.writeFileSync(labConfig, originalConfig, { mode: 0o600 })
    fs.writeFileSync(secretFile, originalSecret, { mode: 0o600 })
    restored = true
    expectedMessageId = null
    const restoreRefresh = refreshLab(undefined)
    if (restoreRefresh.status !== 0) throw new Error(`lab refresh (real profile) failed with status ${restoreRefresh.status}`)
    await waitLabReady()

    const manifestAfter = readManifest()
    results.negative.materialized = manifestAfter?.metadata?.global?.openclaw ?? null
    if (manifestAfter?.metadata?.global?.openclaw) fail("real profile manifest unexpectedly carried an openclaw block")

    await warmPlugin()
    const gatewayBefore = gateway.bodies.length
    const discordBefore = discord.polls.length
    const negativeSession = await newSession()
    await sendPrompt(negativeSession, "T29 negative probe")
    await waitIdle(negativeSession)
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    results.negative.outboundDelta = gateway.bodies.length - gatewayBefore
    results.negative.inboundDelta = discord.polls.length - discordBefore
    if (gateway.bodies.length !== gatewayBefore) fail("absent openclaw config still dispatched to the loopback gateway")
    if (discord.polls.length !== discordBefore) fail("absent openclaw config still polled the loopback Discord server")
  } finally {
    try { await gateway.close() } catch { /* best effort */ }
    try { await discord.close() } catch { /* best effort */ }
    try { await provider.close() } catch { /* best effort */ }
    restoreLab()
  }

  if (!packagesByteIdentical) fail("packages/ owners are not byte-identical to HEAD")

  const v1After = snapshotV1()
  const v1Intact = v1Before.configHash === v1After.configHash && v1Before.configFiles === v1After.configFiles
  if (!v1Intact) fail("V1 config snapshot changed during the experiment")

  const report = {
    positive: results.positive,
    negative: results.negative,
    packagesByteIdentical,
    v1: { before: v1Before, after: v1After, intact: v1Intact },
    failures,
  }
  fs.writeFileSync(path.join(evidenceDir, "T29-result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })

  const lines = [
    "# Oh My Rigel — T29 native V2 bidirectional OpenClaw (live lab)",
    "",
    `- Lab: opencode-v2-lab.service (127.0.0.1:4097); V1 untouched (config hash/counts identical): ${v1Intact ? "yes" : "no"}.`,
    `- packages/ owners byte-identical to HEAD: ${packagesByteIdentical ? "yes" : "no"}.`,
    "",
    "## Positive (openclaw enabled, loopback services)",
    `- Manifest materialized openclaw: ${JSON.stringify(results.positive.materialized)}.`,
    `- Outbound payload captured by the loopback gateway: ${JSON.stringify(results.positive.outbound)}.`,
    `- Inbound: ${JSON.stringify(results.positive.inbound)}; transcript contained "[reply:discord] ${INBOUND_TEXT}": ${results.positive.inbound?.injected ? "yes" : "no"}.`,
    "",
    "## Negative (real profile, no openclaw block)",
    `- Manifest openclaw after restore: ${JSON.stringify(results.negative.materialized)}.`,
    `- Outbound delta: ${results.negative.outboundDelta}; inbound poll delta: ${results.negative.inboundDelta}.`,
    "",
    `## Verdict: ${failures.length === 0 ? "PASS" : "FAIL"}`,
    ...(failures.length ? ["", "Failures:", ...failures.map((entry) => `- ${entry}`)] : []),
    "",
  ].join("\n")
  fs.writeFileSync(path.join(evidenceDir, "task-29.txt"), lines, { mode: 0o600 })
  console.log(lines)
  console.log(JSON.stringify(report, null, 2))

  if (failures.length > 0) { console.error(`T29 live experiment FAILED: ${failures.length} assertion(s)`); process.exit(1) }
  console.log("T29 live experiment PASSED (lab-only; outbound payload observed; inbound injected; absent config no-op; V1 intact)")
}

main().catch((error) => {
  console.error(`T29 live experiment error: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
