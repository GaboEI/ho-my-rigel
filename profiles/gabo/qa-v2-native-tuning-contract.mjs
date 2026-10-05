#!/usr/bin/env node
/**
 * Drives the existing isolated V2 laboratory and records the exact tuning
 * options applied at the V2 context boundary. It never starts,
 * stops, refreshes, or otherwise launches OpenCode.
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const service = process.env.RIGEL_V2_SERVICE ?? "opencode-v2-lab.service"
const labRoot = process.env.RIGEL_V2_LAB_ROOT ?? path.join(os.homedir(), ".local/share/opencode-v2-lab")
const secretFile = path.join(labRoot, "secret.env")
const evidenceDir = path.join(root, ".omo/evidence/20261003-task-9-tuning")
const tuningReceiptFile = path.join(labRoot, "state/oh-my-rigel/agent-tuning-applied.json")
const serverURL = process.env.RIGEL_V2_SERVER_URL ?? "http://127.0.0.1:4097"
const uid = typeof process.getuid === "function" ? process.getuid() : undefined
const serviceEnv = {
  ...process.env,
  ...(uid === undefined || process.env.XDG_RUNTIME_DIR ? {} : { XDG_RUNTIME_DIR: `/run/user/${uid}` }),
  ...(uid === undefined || process.env.DBUS_SESSION_BUS_ADDRESS ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` }),
}

function serviceCommand(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8", env: serviceEnv })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function labPassword() {
  const line = fs.readFileSync(secretFile, "utf8").split(/\r?\n/).find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  if (!line) throw new Error(`Lab credentials are unavailable: ${secretFile}`)
  return line.slice("OPENCODE_PASSWORD=".length)
}

async function api(pathname, authorization, init = {}) {
  const response = await fetch(`${serverURL}${pathname}`, {
    ...init,
    headers: { authorization, ...init.headers },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

function tuningReceipt() {
  try { return JSON.parse(fs.readFileSync(tuningReceiptFile, "utf8")) } catch { return undefined }
}

async function waitFor(check, message, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(message)
}

function waitForTuningReceipt(agent, startedAt, predicate, description) {
  return waitFor(() => {
    const receipt = tuningReceipt()
    const recordedAt = Date.parse(receipt?.recordedAt)
    if (receipt?.agent !== agent || !Number.isFinite(recordedAt) || recordedAt < startedAt || !predicate(receipt.payload ?? {})) return undefined
    return receipt
  }, `No provider-bound payload proved ${description} for ${agent}`)
}

function waitForSuccessfulSession(sessionID, authorization) {
  return waitFor(async () => {
    const context = await api(`/api/session/${sessionID}/context`, authorization)
    const messages = Array.isArray(context?.data) ? context.data : []
    const idle = messages.findLast((entry) => entry?.type === "idle")
    if (idle?.outcome === "failed") throw new Error(`Provider execution failed for ${sessionID}`)
    return idle?.outcome === "succeeded" ? context : undefined
  }, `Provider execution did not complete for ${sessionID}`)
}

async function promptAgent(agent, authorization, sessions) {
  const created = await api("/api/session", authorization, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, location: { directory: path.join(labRoot, "home") } }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error(`V2 did not create a ${agent} session`)
  sessions.push(sessionID)
  await api(`/api/session/${sessionID}/prompt`, authorization, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Reply only TUNING_OK.", resume: true }),
  })
  return sessionID
}

const sessions = []
const password = labPassword()
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

try {
  const active = serviceCommand("systemctl", ["--user", "is-active", service]).trim()
  if (active !== "active") throw new Error(`${service} is not active`)
  await api("/api/session/active", authorization)
  const sisyphusStartedAt = Date.now()
  const sisyphusSession = await promptAgent("Sisyphus-Junior", authorization, sessions)
  const sisyphus = await waitForTuningReceipt(
    "Sisyphus-Junior",
    sisyphusStartedAt,
    (payload) => payload.max_output_tokens === 64000 || payload.max_tokens === 64000,
    "maxTokens=64000",
  )
  const sisyphusContext = await waitForSuccessfulSession(sisyphusSession, authorization)
  const atlasStartedAt = Date.now()
  const atlasSession = await promptAgent("Atlas - Plan Executor", authorization, sessions)
  const atlas = await waitForTuningReceipt(
    "Atlas - Plan Executor",
    atlasStartedAt,
    (payload) => payload.temperature === 0.1,
    "temperature=0.1",
  )
  const atlasContext = await waitForSuccessfulSession(atlasSession, authorization)
  const proof = {
    service,
    serverURL,
    spawnedOpenCode: false,
    requestsAcceptedByProvider: true,
    sessions,
    payloads: [sisyphus, atlas],
    outcomes: [sisyphusContext, atlasContext].map((context) => context.data.findLast((entry) => entry?.type === "idle")),
  }
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, "live-provider-payloads.json"), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
} finally {
  for (const sessionID of sessions) {
    try {
      await api(`/api/session/${sessionID}`, authorization, { method: "DELETE" })
    } catch (error) {
      console.error(`Could not remove isolated V2 QA session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
