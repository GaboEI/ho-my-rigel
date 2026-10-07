#!/usr/bin/env node
/**
 * T30 live QA (lab-only): complete the interactive MCP OAuth login from inside
 * the native V2 runtime, without an external CLI.
 *
 * It talks ONLY to the authorized isolated V2 laboratory
 * (`opencode-v2-lab.service`, port 4097). It never spawns OpenCode, never uses
 * Docker, and never reads or writes V1; a read-only V1 snapshot is compared
 * before and after. When the lab is not reachable it declares SKIP with the
 * reason instead of silently passing.
 *
 * Each command runs in its own session, created in an empty directory outside
 * any repository so the report's short model turn cannot explore a large tree
 * and queue the next command behind it. After the interactive step the session
 * is interrupted so the command's final report materializes.
 *
 * Positive: `/mcp-oauth login <name> --server-url <loopback> --no-browser`
 * completes PKCE against a loopback authorization server (discovery, DCR,
 * authorization code, token exchange); the token round-trips through the lab
 * `ctx.storage` domain, proven by a subsequent `status` reporting it VALID with
 * the token redacted. `logout` clears it. Negative: a callback with a wrong
 * `state` fails loudly, `status` then reports no token, and no token request
 * reaches the loopback server.
 *
 * Usage: node profiles/gabo/qa-v2-t30-mcp-oauth.mjs
 */
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const evidenceDir = path.join(root, ".omo/evidence/20261007-t30-mcp-oauth")
// Outside any repository: an empty directory keeps the report's model turn from
// walking a project tree. The lab must be able to read it (same user).
const sessionDir = path.join(os.tmpdir(), "rigel-t30-mcp-oauth-cwd")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const secretFile = path.join(labRoot, "secret.env")
const labUrl = process.env.RIGEL_V2_LAB_URL || "http://127.0.0.1:4097"
const oauthPort = Number(process.env.RIGEL_T30_OAUTH_PORT || "0")
const accessTokenValue = "t30-loopback-access"
const stamp = Date.now()
const serverName = `t30-lab-${stamp}`
const negativeName = `t30-mismatch-${stamp}`

function skip(reason) {
  console.log(`Rigel V2 T30 mcp-oauth live QA: SKIP (${reason})`)
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

async function waitFor(check, message, timeout = 60_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try { const value = await check(); if (value) return value } catch { /* retry */ }
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const password = fs.existsSync(secretFile)
  ? (fs.readFileSync(secretFile, "utf8").split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD=")) ?? "").slice("OPENCODE_PASSWORD=".length).trim()
  : ""
if (!password) skip(`no lab credentials at ${secretFile}`)
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

async function api(method, pathname, body, timeoutMs = 30_000) {
  const response = await fetch(labUrl + pathname, {
    method,
    headers: { authorization, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

async function sessionMessages(sessionID) {
  const response = await api("GET", `/api/session/${sessionID}/message?order=asc&limit=200`, undefined, 20_000)
  const rows = Array.isArray(response.json?.data) ? response.json.data : []
  return rows.map((row) => (typeof row?.text === "string" ? row.text : "")).filter(Boolean)
}

// Loopback authorization server: PRM discovery, AS metadata, DCR, and token.
function startOAuthServer() {
  const requests = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    requests.push(`${request.method} ${url.pathname}`)
    const origin = `http://127.0.0.1:${request.socket.localPort}`
    const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)) }
    if (url.pathname === "/.well-known/oauth-protected-resource") return send(200, { authorization_servers: [origin] })
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      })
    }
    if (url.pathname === "/register") return send(200, { client_id: "t30-loopback-client" })
    if (url.pathname === "/token") return send(200, { access_token: accessTokenValue, refresh_token: "t30-loopback-refresh", expires_in: 3600 })
    return send(404, {})
  })
  return new Promise((resolve) => server.listen(oauthPort, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  })))
}

const createdSessions = []
async function createSession(title) {
  const created = await api("POST", "/api/session", { title, location: { directory: sessionDir } })
  const sessionID = created.json?.data?.id ?? created.json?.id
  if (typeof sessionID !== "string") throw new Error(`session create failed: ${JSON.stringify(created.json).slice(0, 200)}`)
  createdSessions.push(sessionID)
  return sessionID
}
function invokeCommand(sessionID, text) {
  return api("POST", `/api/session/${sessionID}/command`, { name: "mcp-oauth", text, delivery: "queue" }).catch(() => undefined)
}
function interruptSession(sessionID) {
  return api("POST", `/api/session/${sessionID}/interrupt`, { resume: false }).catch(() => undefined)
}
function findAuthorizationUrl(messages) {
  for (const text of messages) {
    const index = text.indexOf("Open this URL to authorize:")
    if (index === -1) continue
    const match = /(https?:\/\/[^\s"'<>]+)/.exec(text.slice(index))
    if (match) return match[1]
  }
  return null
}

// The provider's redirect_uri uses `localhost`, which may resolve to IPv6 while
// the callback server binds 127.0.0.1; drive the callback on 127.0.0.1 directly.
async function driveCallback(redirectUri, { code, state }) {
  const url = new URL(redirectUri)
  url.hostname = "127.0.0.1"
  url.searchParams.set("code", code)
  url.searchParams.set("state", state)
  const response = await fetch(url)
  return response.status
}

async function runCommandCapturing(sessionTitle, text, matcher) {
  const sessionID = await createSession(sessionTitle)
  invokeCommand(sessionID, text)
  try {
    await waitFor(async () => (await sessionMessages(sessionID)).some(matcher), `no output matched for "${text}"`)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; saw ${JSON.stringify(await sessionMessages(sessionID))}`)
  }
  return sessionID
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(sessionDir, { recursive: true })
  const checks = {}
  const details = { serverName, oauthPort }
  const v1Before = snapshotV1()
  let server
  try {
    const ready = await waitFor(async () => {
      const response = await api("GET", "/api/command", undefined, 10_000)
      if (response.status !== 200) return false
      const names = (response.json?.data ?? []).map((entry) => entry?.name)
      return names.includes("mcp-oauth") ? names : false
    }, `lab not reachable or command never materialized at ${labUrl}`, 90_000)
    checks.commandCatalogued = Array.isArray(ready) && ready.includes("mcp-oauth")

    // Warm-up: V2 loads a local plugin lazily on the first turn; pay that cost
    // on a throwaway session so the measured login is not delayed by cold start.
    const warmupSession = await createSession("t30-mcp-oauth warmup")
    invokeCommand(warmupSession, `status ${serverName}`)
    await waitFor(async () => (await sessionMessages(warmupSession)).length > 0, "warm-up command produced no output", 180_000)
    await interruptSession(warmupSession)

    server = await startOAuthServer()

    // --- Positive login (own session) ---
    const loginSession = await createSession("t30-mcp-oauth login")
    invokeCommand(loginSession, `login ${serverName} --server-url ${server.url} --no-browser`)
    const authorizationUrl = await waitFor(async () => findAuthorizationUrl(await sessionMessages(loginSession)), "authorization URL never appeared in the session", 180_000)
    const authorize = new URL(authorizationUrl)
    const redirectUri = authorize.searchParams.get("redirect_uri")
    const state = authorize.searchParams.get("state")
    details.authorize = { redirectUri, statePresent: Boolean(state) }
    await interruptSession(loginSession)
    details.callbackStatus = await driveCallback(redirectUri, { code: "t30-loopback-code", state })
    await waitFor(async () => (await sessionMessages(loginSession)).some((text) => text.includes(`Successfully authenticated with ${serverName}`)), "login success message never appeared")
    const loginMessages = await sessionMessages(loginSession)
    checks.manualNotice = loginMessages.some((text) => text.includes("Manual callback mode"))
    checks.noTokenLeaked = !loginMessages.some((text) => text.includes(accessTokenValue) || text.includes("t30-loopback-refresh"))
    checks.discoveryHit = server.requests.some((entry) => entry.includes("/.well-known/oauth-protected-resource"))
    checks.authorizationServerHit = server.requests.some((entry) => entry.includes("/.well-known/oauth-authorization-server"))
    checks.dcrHit = server.requests.includes("POST /register")
    checks.tokenExchangeHit = server.requests.includes("POST /token")

    // --- status proves the token persisted through ctx.storage (own session) ---
    const statusSession = await runCommandCapturing("t30-mcp-oauth status", `status ${serverName}`, (text) => text.includes(`OAuth Status for ${serverName}:`))
    const statusMessages = await sessionMessages(statusSession)
    checks.statusRedacted = statusMessages.some((text) => text.includes("Access Token: [REDACTED]"))
    checks.statusValid = statusMessages.some((text) => text.includes("(VALID)"))
    checks.statusNoLeak = !statusMessages.some((text) => text.includes(accessTokenValue))

    // --- logout (own session) ---
    await runCommandCapturing("t30-mcp-oauth logout", `logout ${serverName} --server-url ${server.url}`, (text) => text.includes(`Successfully removed tokens for ${serverName}`))

    // --- status after logout proves the token was cleared (own session) ---
    const afterLogoutSession = await runCommandCapturing("t30-mcp-oauth after-logout", `status ${serverName}`, (text) => text.includes(`No tokens found for ${serverName}`))
    checks.logoutCleared = (await sessionMessages(afterLogoutSession)).some((text) => text.includes(`No tokens found for ${serverName}`))

    // --- Negative: callback with a wrong state (own session) ---
    const tokenHitsBefore = server.requests.filter((entry) => entry === "POST /token").length
    const negativeSession = await createSession("t30-mcp-oauth negative")
    invokeCommand(negativeSession, `login ${negativeName} --server-url ${server.url} --no-browser`)
    const mismatchUrl = await waitFor(async () => findAuthorizationUrl(await sessionMessages(negativeSession)), "negative authorization URL never appeared", 180_000)
    const mismatchRedirect = new URL(mismatchUrl).searchParams.get("redirect_uri")
    await interruptSession(negativeSession)
    details.negativeCallbackStatus = await driveCallback(mismatchRedirect, { code: "t30-bad", state: "tampered-state" })
    await waitFor(async () => (await sessionMessages(negativeSession)).some((text) => text.includes("Failed to authenticate") && text.includes("state parameter mismatch")), "negative failure message never appeared")
    const mismatchMessages = await sessionMessages(negativeSession)
    checks.negativeFailsClearly = mismatchMessages.some((text) => text.includes(`Failed to authenticate with ${negativeName}`) && text.includes("state parameter mismatch"))
    checks.negativeNoTokenExchange = server.requests.filter((entry) => entry === "POST /token").length === tokenHitsBefore
    checks.negativeNoLeak = !mismatchMessages.some((text) => text.includes(accessTokenValue))

    // --- status for the negative server reports nothing persisted (own session) ---
    const negativeStatusSession = await runCommandCapturing("t30-mcp-oauth negative-status", `status ${negativeName}`, (text) => text.includes(`No tokens found for ${negativeName}`))
    checks.negativeNoPersist = (await sessionMessages(negativeStatusSession)).some((text) => text.includes(`No tokens found for ${negativeName}`))
  } finally {
    if (server?.close) await server.close().catch(() => {})
    for (const sessionID of createdSessions) await api("DELETE", `/api/session/${sessionID}`).catch(() => {})
  }

  const v1After = snapshotV1()
  checks.v1ConfigUnchanged = v1Before.configHash === v1After.configHash
  checks.v1FileCountsUnchanged =
    v1Before.configFiles === v1After.configFiles &&
    v1Before.shareFiles === v1After.shareFiles &&
    v1Before.goalFiles === v1After.goalFiles &&
    v1Before.cacheFiles === v1After.cacheFiles

  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key)
  const report = { labUrl, oauthPort, serverName, v1Before, v1After, checks, details, requests: server?.requests ?? [], failed, at: new Date().toISOString() }
  fs.writeFileSync(path.join(evidenceDir, "t30-live-qa.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ checks, details, failed }, null, 2))
  if (failed.length > 0) {
    console.error(`Rigel V2 T30 mcp-oauth live QA FAILED: ${failed.join(", ")}`)
    process.exit(1)
  }
  console.log("Rigel V2 T30 mcp-oauth live QA PASS (live PKCE login, storage persistence via status, logout, negative state mismatch; V1 intact)")
}

await main()
