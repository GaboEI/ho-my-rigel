#!/usr/bin/env node
/**
 * Live contract for the remaining native builtin commands
 * (`refactor`, `remove-ai-slops`, `handoff`, `hyperplan`).
 *
 * It talks ONLY to the authorized isolated V2 laboratory
 * (`opencode-v2-lab.service`, port 4097). It never spawns OpenCode, never uses
 * Docker, and never reads or writes V1. When that service is not reachable it
 * declares SKIP with the reason instead of silently passing.
 *
 * Readiness: `ctx.command.transform` registers the commands asynchronously
 * during plugin `setup()`, and the host serves `/api/command` before setup
 * finishes (observed: 0/4 immediately after a restart, 4/4 a few seconds
 * later). The contract therefore waits on the official `GET /api/command`
 * surface until the registrations are materialized, bounded by a timeout. This
 * is startup synchronization, not a relaxed assertion: the checks below still
 * fail if the commands never appear.
 *
 * Modes (env):
 *   RIGEL_BUILTIN_RESTART=1                 restart the lab service first, to
 *                                           prove the commands come from a fresh
 *                                           boot and not residual state.
 *   RIGEL_BUILTIN_DISABLED_COMMAND=<name>   expect that command to be absent
 *                                           from the catalog AND to reject
 *                                           execution with CommandNotFoundError,
 *                                           proving disabled_commands is honored.
 *
 * Usage: node profiles/gabo/qa-v2-builtin-commands-contract.mjs
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const secretFile = path.join(labRoot, "secret.env")
const baseUrl = process.env.RIGEL_V2_LAB_URL || "http://127.0.0.1:4097"
const evidenceDir = path.join(root, ".omo/evidence/20261006-t35-builtin-commands")
const service = process.env.RIGEL_V2_SERVICE || "opencode-v2-lab.service"
const ALL_COMMANDS = ["refactor", "remove-ai-slops", "handoff", "hyperplan"]
const disabled = process.env.RIGEL_BUILTIN_DISABLED_COMMAND || null
const expected = ALL_COMMANDS.filter((name) => name !== disabled)
const restart = process.env.RIGEL_BUILTIN_RESTART === "1"
const READY_TIMEOUT_MS = Number(process.env.RIGEL_BUILTIN_READY_TIMEOUT_MS || 90000)

function skip(reason) {
  console.log(`Rigel V2 builtin-commands contract: SKIP (${reason})`)
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

async function api(method, pathname, body, timeoutMs = 90_000) {
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

async function catalogNames() {
  const response = await api("GET", "/api/command", undefined, 10_000)
  if (response.status !== 200) return null
  return (response.json?.data ?? []).map((entry) => entry?.name).filter((name) => typeof name === "string")
}

if (restart) {
  const result = spawnSync("systemctl", ["--user", "restart", service], { stdio: "inherit" })
  if (result.status !== 0) skip(`lab service restart failed (${service})`)
}

const startedAt = Date.now()
let names = await catalogNames()
while (!(names && expected.every((name) => names.includes(name))) && Date.now() - startedAt < READY_TIMEOUT_MS) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  names = await catalogNames()
}
const readinessMs = Date.now() - startedAt
if (!names) skip(`lab not reachable at ${baseUrl}`)
if (!expected.every((name) => names.includes(name))) {
  console.error(`Rigel V2 builtin-commands contract FAILED: catalog never materialized ${expected.join(", ")} within ${READY_TIMEOUT_MS}ms (saw ${JSON.stringify(names)})`)
  process.exit(1)
}

const checks = { readinessMaterialized: true }
for (const name of ALL_COMMANDS) {
  const occurrences = names.filter((entry) => entry === name).length
  if (name === disabled) {
    checks[`catalogAbsent:${name}`] = occurrences === 0
  } else {
    checks[`catalogPresent:${name}`] = occurrences === 1
    checks[`catalogUnique:${name}`] = occurrences === 1
  }
}

const details = {}
for (const name of expected) {
  const created = await api("POST", "/api/session", { title: `t35-contract-${name}` })
  if (created.status !== 200) {
    checks[`session:${name}`] = false
    details[name] = { sessionError: created.status }
    continue
  }
  const sessionID = created.json.data.id
  const argument = `T35-CONTRACT-${name}`
  const invoked = await api("POST", `/api/session/${sessionID}/command`, { name, text: argument, delivery: "queue" })
  const messages = await api("GET", `/api/session/${sessionID}/message?type=user&order=asc&limit=20`)
  const rows = Array.isArray(messages.json?.data) ? messages.json.data : []
  const delivered = rows.map((row) => row?.text).find((text) => typeof text === "string" && text.startsWith("<command-instruction>")) ?? ""
  checks[`invoke:${name}`] = invoked.status === 204
  checks[`delivered:${name}`] = delivered.startsWith("<command-instruction>")
  checks[`argument:${name}`] = delivered.includes(argument)
  checks[`placeholders:${name}`] = !delivered.includes("$ARGUMENTS") && !delivered.includes("$SESSION_ID") && !delivered.includes("$TIMESTAMP")
  if (name === "handoff") checks["session:handoff"] = delivered.includes(sessionID)
  details[name] = { sessionID, httpStatus: invoked.status, deliveredBytes: delivered.length }
}

if (disabled) {
  const created = await api("POST", "/api/session", { title: "t35-contract-disabled" })
  if (created.status === 200) {
    const invoked = await api("POST", `/api/session/${created.json.data.id}/command`, { name: disabled, text: "x", delivery: "queue" })
    checks[`disabledInvoke404:${disabled}`] = invoked.status === 404 && invoked.json?._tag === "CommandNotFoundError"
    details.disabled = { command: disabled, httpStatus: invoked.status }
  } else {
    checks[`disabledInvoke404:${disabled}`] = false
  }
}

const negative = await api("POST", "/api/session", { title: "t35-contract-negative" })
if (negative.status === 200) {
  const negativeInvoke = await api("POST", `/api/session/${negative.json.data.id}/command`, { name: "t35-contract-missing", text: "x", delivery: "queue" })
  checks["negative:CommandNotFoundError"] = negativeInvoke.status === 404 && negativeInvoke.json?._tag === "CommandNotFoundError"
} else {
  checks["negative:CommandNotFoundError"] = false
}

const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key)
const report = {
  service,
  baseUrl,
  restart,
  disabledCommand: disabled,
  readinessMs,
  catalogNames: names,
  expected,
  checks,
  details,
  failed,
}
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
const evidenceName = disabled ? "qa-contract-live-disabled.json" : "qa-contract-live.json"
fs.writeFileSync(path.join(evidenceDir, evidenceName), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (failed.length > 0) {
  console.error(`Rigel V2 builtin-commands contract FAILED: ${failed.join(", ")}`)
  process.exit(1)
}
console.log(`Rigel V2 builtin-commands contract PASS (readiness ${readinessMs}ms, disabled=${disabled ?? "none"})`)
