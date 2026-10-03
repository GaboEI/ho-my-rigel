#!/usr/bin/env node
/** Verify native permissions through the existing isolated V2 lab service. */
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const service = process.env.RIGEL_V2_SERVICE ?? "opencode-v2-lab.service"
const labRoot = process.env.RIGEL_V2_LAB_ROOT ?? path.join(os.homedir(), ".local/share/opencode-v2-lab")
const labHome = process.env.RIGEL_V2_HOME ?? path.join(labRoot, "home")
const serverURL = process.env.RIGEL_V2_SERVER_URL ?? "http://127.0.0.1:4097"
const runtime = path.join(labRoot, "rigel/runtime/rigel-v2-native")
const manifestFile = path.join(runtime, "rigel-v2-native-agent-manifest.mjs")
const permissionFile = path.join(runtime, "rigel-v2-native-permissions.mjs")
const evidenceDir = path.join(root, ".omo/evidence/20261003-task-10-permissions")
const secretFile = path.join(labRoot, "secret.env")
const uid = typeof process.getuid === "function" ? process.getuid() : undefined
const serviceEnv = {
  ...process.env,
  ...(uid === undefined || process.env.XDG_RUNTIME_DIR ? {} : { XDG_RUNTIME_DIR: `/run/user/${uid}` }),
  ...(uid === undefined || process.env.DBUS_SESSION_BUS_ADDRESS ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` }),
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function serviceCommand(...args) {
  const result = childProcess.spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: serviceEnv })
  if (result.status !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function password() {
  const line = fs.readFileSync(secretFile, "utf8").split(/\r?\n/).find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  if (!line) throw new Error(`Lab credentials are unavailable: ${secretFile}`)
  return line.slice("OPENCODE_PASSWORD=".length)
}

const authorization = `Basic ${Buffer.from(`opencode:${password()}`).toString("base64")}`
async function api(pathname, init = {}) {
  const response = await fetch(`${serverURL}${pathname}`, {
    ...init,
    headers: { authorization, ...init.headers },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

function ruleMap(rules) {
  const result = new Map()
  for (const rule of rules ?? []) result.set(`${rule.action}\0${rule.resource}`, rule.effect)
  return result
}

function toolParts(messages) {
  return messages.flatMap((message) => message.type === "assistant"
    ? (message.content ?? []).filter((part) => part.type === "tool")
    : [])
}

async function prompt(agent, text, sessions) {
  const created = await api("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, location: { directory: labHome } }),
  })
  const sessionID = created.data?.id ?? created.id
  assert(typeof sessionID === "string", `V2 did not create a ${agent} session`)
  sessions.push(sessionID)
  await api(`/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, resume: true }),
  })
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const context = await api(`/api/session/${sessionID}/context`)
    const messages = Array.isArray(context.data) ? context.data : []
    if (messages.some((message) => message.type === "idle" || message.type === "error")) return { sessionID, messages }
  }
  throw new Error(`Provider execution did not finish for ${agent}`)
}

async function probe(agent, text, sessions, predicate, description) {
  let lastParts = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await prompt(agent, text, sessions)
    lastParts = toolParts(result.messages)
    const part = lastParts.find(predicate)
    if (part) return { attempt, part }
  }
  const observed = lastParts.map((part) => `${part.name}:${part.state?.status ?? "unknown"}`).join(",") || "none"
  throw new Error(`${description}; observed tool parts: ${observed}`)
}

const sessions = []
const probeFile = path.join(labHome, "permission-probe.txt")
try {
  assert(serviceCommand("is-active", service) === "active", `${service} is not active`)
  assert(fs.existsSync(permissionFile), "deployed permission authority is missing")
  assert(fs.existsSync(manifestFile), "deployed agent manifest is missing")

  const authority = await import(`${pathToFileURL(permissionFile).href}?qa=${Date.now()}`)
  const manifest = (await import(`${pathToFileURL(manifestFile).href}?qa=${Date.now()}`)).default
  const globalRules = authority.translateV1Permissions(manifest.metadata?.global?.permission).rules
  const globalGates = authority.translateGlobalTools(manifest.metadata?.global?.tools)
  const forbiddenActions = new Set([
    "call_omo_agent", "task_*", "teammate", "team_*", "look_at",
    "interactive_bash", "skill_mcp", "grep_app_*", "lsp_*", "Lsp*",
  ])
  const table = []

  for (const [id, definition] of Object.entries(manifest.agents ?? {})) {
    const live = (await api(`/api/agent/${encodeURIComponent(id)}`)).data
    assert(live?.id === id, `live agent missing or mismatched: ${id}`)
    const translated = authority.translateV1Permissions(definition.permission ?? definition.permissions)
    const expected = authority.mergePermissionRules([globalRules, translated.rules])
    const observed = ruleMap(live.permissions)
    const missing = expected.filter((rule) => observed.get(`${rule.action}\0${rule.resource}`) !== rule.effect)
    const passthrough = (live.permissions ?? []).filter((rule) => forbiddenActions.has(rule.action))
    const expectedKeys = new Set(expected.map((rule) => `${rule.action}\0${rule.resource}`))
    const baseline = (live.permissions ?? []).filter((rule) => !expectedKeys.has(`${rule.action}\0${rule.resource}`))
    assert(missing.length === 0, `${id} live rules differ from translated V1 rules: ${JSON.stringify(missing)}`)
    assert(passthrough.length === 0, `${id} leaked V1-only actions into AgentV2Info.permissions`)
    table.push({
      id,
      baselineRulesRetained: baseline.length,
      globalRules: globalRules.length,
      agentRules: translated.rules.length,
      matchedRules: expected.length,
      toolGates: translated.toolGates,
      pass: true,
    })
  }

  const multimodal = manifest.agents?.["multimodal-looker"]
  const multimodalTranslation = authority.translateV1Permissions(multimodal?.permission ?? multimodal?.permissions)
  const multimodalNative = ruleMap(multimodalTranslation.rules)
  assert(multimodalNative.get("read\0*") === "allow", "multimodal-looker must allow read")
  for (const action of authority.V2_PERMISSION_ACTIONS) {
    if (action !== "read") assert(multimodalNative.get(`${action}\0*`) === "deny", `multimodal-looker must deny ${action}`)
  }
  assert(authority.evaluateToolNameGate(multimodalTranslation.toolGates, "read") === "allow", "multimodal read gate must allow")
  assert(authority.evaluateToolNameGate(multimodalTranslation.toolGates, "execute") === "deny", "multimodal wildcard must deny execute")
  assert(authority.evaluateToolNameGate(globalGates, "task_create") === "deny", "global tools must deny task_*")
  assert(authority.evaluateToolNameGate(globalGates, "team_create") === "deny", "global tools must deny team_*")

  const denied = await probe(
    "multimodal-looker",
    "Call the tool named ctx_stats exactly once now, with no arguments. After it returns, reply DONE.",
    sessions,
    (part) => part.state?.status === "error"
      && part.state?.error?.message?.includes("Rigel tool permission denied")
      && part.state.error.message.includes("agent=multimodal-looker"),
    "multimodal-looker did not produce a live permission denial",
  )
  const deniedPart = denied.part
  assert(deniedPart.executed === false, "denied tool reached the executor")

  fs.writeFileSync(probeFile, "RIGEL_READ_PROBE_OK\n", { mode: 0o600 })
  const allowed = await probe(
    "multimodal-looker",
    `You must invoke the read tool now. Do not infer or describe. Read the exact file ${probeFile}, then reply with its exact contents.`,
    sessions,
    (part) => part.name === "read" && part.state?.status === "completed"
      && JSON.stringify(part).includes("RIGEL_READ_PROBE_OK"),
    "multimodal-looker did not complete the allowed read tool",
  )
  const allowedPart = allowed.part
  assert(!allowedPart.state?.error, "allowed read returned an error")

  const deployedHashes = {
    entrypoint: sha256(path.join(runtime, "index.js")),
    permissions: sha256(permissionFile),
    agents: sha256(path.join(runtime, "rigel-v2-native-agents.mjs")),
    manifest: sha256(manifestFile),
  }
  assert(deployedHashes.entrypoint === sha256(path.join(root, "profiles/gabo/opencode/rigel-v2-native.mjs")), "deployed entrypoint differs from source")
  assert(deployedHashes.permissions === sha256(path.join(root, "profiles/gabo/opencode/rigel-v2-native-permissions.mjs")), "deployed permission authority differs from source")
  assert(deployedHashes.agents === sha256(path.join(root, "profiles/gabo/opencode/rigel-v2-native-agents.mjs")), "deployed agent adapter differs from source")

  const proof = {
    service,
    serverURL,
    spawnedOpenCode: false,
    rosterCount: table.length,
    globalRules,
    globalGates,
    table,
    multimodal: {
      onlyReadAllowed: true,
      deniedTool: deniedPart.name,
      deniedExecuted: deniedPart.executed,
      deniedMessage: deniedPart.state.error.message,
      deniedAttempt: denied.attempt,
      allowedTool: allowedPart.name,
      allowedStatus: allowedPart.state.status,
      allowedAttempt: allowed.attempt,
    },
    deployedHashes,
  }
  const lines = [
    "# Task 10 live permission contract",
    "",
    `service=${service}`,
    `spawned_opencode=${proof.spawnedOpenCode}`,
    `roster=${table.length}/${Object.keys(manifest.agents ?? {}).length}`,
    ...table.map((row) => `PASS ${row.id} baseline=${row.baselineRulesRetained} global=${row.globalRules} agent=${row.agentRules} matched=${row.matchedRules} gates=${row.toolGates.length}`),
    `PASS multimodal-looker allowed=${allowedPart.name}:${allowedPart.state.status} attempt=${allowed.attempt}`,
    `PASS multimodal-looker denied=${deniedPart.name} executed=${deniedPart.executed} attempt=${denied.attempt}`,
    `denial=${deniedPart.state.error.message}`,
  ]
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, "live-permission-contract.json"), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(evidenceDir, "live-permission-contract.txt"), `${lines.join("\n")}\n`, { mode: 0o600 })
  process.stdout.write(`${lines.join("\n")}\n`)
} finally {
  for (const sessionID of sessions) {
    try { await api(`/api/session/${sessionID}`, { method: "DELETE" }) } catch (error) {
      console.error(`Could not remove isolated V2 QA session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try { fs.unlinkSync(probeFile) } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Could not remove isolated V2 permission probe: ${error instanceof Error ? error.message : String(error)}`)
  }
}
