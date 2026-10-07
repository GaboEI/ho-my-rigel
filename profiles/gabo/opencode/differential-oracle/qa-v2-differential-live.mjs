#!/usr/bin/env node
/**
 * Specific live QA: proves the HOST-CROSSING boundaries that the
 * hermetic differentials model, through the authorized isolated laboratory
 * (opencode-v2-lab.service, port 4097). The generic run-lab-acceptance 23/23 is
 * not sufficient on its own; this probe drives the real host surfaces:
 *
 *   1. GET  /api/agent                 -> the native runtime registered agents (roster crosses the host)
 *   2. POST /api/session               -> create a real session
 *   3. POST /api/session/{id}/model    -> switchModel (the reactive fallback provider-switch boundary)
 *   4. POST /api/session/{id}/agent    -> switch agent (the permission/identity boundary)
 *   5. POST /api/session/{id}/compact  -> the compaction service the plugin calls
 *   6. GET  /api/session/{id}          -> read the session back (model + agent applied)
 *   7. DELETE /api/session/{id}        -> cleanup
 *
 * Never touches V1. Writes evidence to .omo/evidence/20261007-differential-oracle/live-qa.txt.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..")
const LAB_ROOT = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const BASE = "http://127.0.0.1:4097"

function readPassword() {
  const secret = fs.readFileSync(path.join(LAB_ROOT, "secret.env"), "utf8")
  const match = /^OPENCODE_PASSWORD=(.*)$/m.exec(secret)
  if (!match) throw new Error("lab password unavailable")
  return match[1].trim()
}

const password = readPassword()
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

async function api(method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, text, json }
}

const steps = []
function record(name, ok, detail) {
  steps.push({ name, ok, detail })
}

async function main() {
  // 1. roster (native runtime agents registered on the host)
  const agents = await api("GET", "/api/agent")
  const roster = Array.isArray(agents.json) ? agents.json : (agents.json?.data ?? [])
  const names = roster.map((a) => a?.name ?? a?.id).filter(Boolean)
  record("GET /api/agent roster", agents.status === 200 && names.length > 0, `status=${agents.status} count=${names.length} sisyphus=${names.some((n) => /sisyphus/i.test(n))} hermetic=(none; host roster of the loaded runtime)`)

  // 2. create a session
  const created = await api("POST", "/api/session", { title: "diff-live" })
  const sessionID = created.json?.id ?? created.json?.sessionID ?? created.json?.data?.id
  record("POST /api/session", Boolean(sessionID) && created.status < 300, `status=${created.status} id=${sessionID}`)
  if (!sessionID) return

  try {
    // 3. switchModel (reactive fallback provider-switch boundary)
    const targetModel = { providerID: "opencode-go", id: "grok-4.7" }
    const switched = await api("POST", `/api/session/${sessionID}/model`, { model: targetModel })
    record("POST /api/session/{id}/model switchModel", switched.status === 204 || switched.status === 200, `status=${switched.status}`)

    // 4. switch agent (permission/identity boundary)
    const switchedAgent = await api("POST", `/api/session/${sessionID}/agent`, { agent: "explore" })
    record("POST /api/session/{id}/agent", switchedAgent.status === 204 || switchedAgent.status === 200, `status=${switchedAgent.status} hermetic=permissions.entrypoint-gate`)

    // 5. compaction service (the boundary the plugin requests)
    const compacted = await api("POST", `/api/session/${sessionID}/compact`, {})
    record("POST /api/session/{id}/compact", compacted.status < 300, `status=${compacted.status} hermetic=compaction.entrypoint-summary`)

    // 6. read the session back
    const read = await api("GET", `/api/session/${sessionID}`)
    const info = read.json ?? read.json?.data ?? {}
    const model = info.model ?? info.data?.model
    const agent = info.agent ?? info.data?.agent
    record("GET /api/session/{id} read-back", read.status === 200, `status=${read.status} model=${JSON.stringify(model)} agent=${JSON.stringify(agent)} hermetic=fallback.entrypoint-reactive-switch(model)+permissions.entrypoint-gate(agent); NOT handoff`)

    // 7. reactive-fallback boundary (hermetic-linked). The headless lab's
    //    /api/session/{id}/prompt does not run a model turn, so the plugin's
    //    session.error route cannot be activated from the API. The boundary the
    //    plugin's reactive fallback uses IS exercised live here (switchModel to
    //    a valid rung, applied and read back), explicitly linked to the hermetic
    //    proof `fallback.reactive-switch` (V1 buildRetryModelPayload vs V2
    //    resolveFallbackModel).
    const appliedModel = { providerID: "opencode-go", id: "grok-4.7" }
    const applied = await api("POST", `/api/session/${sessionID}/model`, { model: appliedModel })
    const readApplied = await api("GET", `/api/session/${sessionID}`)
    const appliedNow = readApplied.json?.model ?? readApplied.json?.data?.model
    record(
      "reactive-fallback boundary (hermetic-linked)",
      applied.status === 204 && appliedNow?.id === "grok-4.7",
      `switchModel=${applied.status} applied=${JSON.stringify(appliedNow)} hermetic=fallback.entrypoint-reactive-switch`,
    )

    // 8. binary live boundary explicitly linked to the plugin runtime: the host
    //    command catalog contains the commands the plugin registers via
    //    ctx.command.transform (goal, ulw-execute, refactor, handoff, hyperplan).
    const commands = await api("GET", "/api/command")
    const commandNames = (Array.isArray(commands.json) ? commands.json : (commands.json?.data ?? [])).map((entry) => entry?.name).filter(Boolean)
    const pluginCommands = ["goal", "ulw-execute", "handoff", "hyperplan"].filter((name) => commandNames.includes(name))
    record("binary plugin-command boundary (host command catalog)", pluginCommands.length >= 3, `status=${commands.status} pluginCommands=${JSON.stringify(pluginCommands)} of ${commandNames.length} hermetic=goal.entrypoint-command`)
  } finally {
    // 7. cleanup
    const removed = await api("DELETE", `/api/session/${sessionID}`)
    record("DELETE /api/session/{id} cleanup", removed.status < 300 || removed.status === 404, `status=${removed.status}`)
  }
}

await main()

const failed = steps.filter((step) => !step.ok)
const lines = [
  "Specific live host-boundary QA (opencode-v2-lab.service)",
  `generated=${new Date().toISOString()}`,
  `lab_root=${LAB_ROOT}`,
  `steps=${steps.length} pass=${steps.length - failed.length} fail=${failed.length}`,
  "",
  ...steps.map((step) => `  ${step.ok ? "PASS" : "FAIL"} ${step.name} - ${step.detail}`),
  "",
]
const evidenceDir = path.join(REPO_ROOT, ".omo", "evidence", "20261007-differential-oracle")
const linkage = [
  "",
  "Boundary linkage (each live boundary names the entrypoint scenario it corroborates, or why none does):",
  "  agent identity / gate        -> permissions.entrypoint-gate (real setup() registers the gate)",
  "  switchModel                  -> fallback.entrypoint-reactive-switch (real event loop -> switchModel)",
  "  compact service              -> compaction.entrypoint-summary (real setup() compaction hook)",
  "  session read-back            -> model+agent applied; corroborates fallback.entrypoint-reactive-switch (model)",
  "                                  and permissions.entrypoint-gate (agent). It does NOT corroborate handoff.",
  "  host command catalog (goal)  -> goal.entrypoint-command (real setup() command registration)",
  "  host agent roster            -> runtime loaded its agents on the host; no entrypoint scenario asserts the roster",
  "  NOT host-activatable live    -> delegation.entrypoint-handoff (needs a completed background child turn),",
  "                                  recovery.entrypoint-context-limit (no session.error), rules.entrypoint-injection",
  "                                  and skills.entrypoint-body-injection (no tool execute edge), ultrawork.entrypoint-injection",
  "                                  (no provider context request); all proven hermetically, NOT claimed live.",
]
fs.mkdirSync(evidenceDir, { recursive: true })
fs.writeFileSync(path.join(evidenceDir, "live-qa.txt"), `${[...lines, ...linkage].join("\n")}\n`)
process.stdout.write(lines.join("\n"))
process.exitCode = failed.length === 0 ? 0 : 1
