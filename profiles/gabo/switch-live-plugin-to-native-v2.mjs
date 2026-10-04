#!/usr/bin/env node
/** Install the native Rigel V2 runtime without loading OmO's V1 plugin API. */
import os from "node:os"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"

const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const home = process.env.RIGEL_V2_HOME || path.join(labRoot, "home")
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const stateRoot = path.join(labRoot, "rigel")
const stateFile = path.join(stateRoot, "active-trial.json")
const configFile = process.env.RIGEL_V2_CONFIG || path.join(labRoot, "config/opencode/opencode.json")
const runtime = path.join(stateRoot, "runtime/rigel-v2-native")
const agentManifest = path.join(stateRoot, "runtime/rigel-v2-agent-manifest.mjs")

function fail(message) { console.error(`Rigel native V2 activation refused: ${message}`); process.exit(1) }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function sha(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function codexPlugin(config) { return (config.plugins || []).find((value) => typeof value === "string" && value.startsWith("oc-codex-multi-auth")) || null }
function fingerprint(config) { return { obsidian: sha(config.mcp?.obsidian), codexPlugin: sha(codexPlugin(config)) } }

if (!fs.existsSync(stateFile)) fail("no hay una prueba Rigel activa")
if (!fs.existsSync(configFile)) fail("no existe la configuración OpenCode activa")
const state = readJson(stateFile)
const before = readJson(configFile)
const beforeFingerprint = fingerprint(before)
const protectedFingerprint = state.protectedFingerprint ?? beforeFingerprint
if (beforeFingerprint.obsidian !== protectedFingerprint.obsidian || beforeFingerprint.codexPlugin !== protectedFingerprint.codexPlugin) {
  fail("un componente protegido no coincide con su huella congelada")
}
if (!fs.existsSync(agentManifest)) fail("no existe el manifiesto nativo de agentes; genéralo antes de activar el runtime")

fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(runtime, "tools"), { recursive: true, mode: 0o700 })
// Copy every runtime module the native entry transitively imports, discovered
// from the source tree instead of a hand-maintained list. A hardcoded list
// silently drops a newly added module and the lab then fails to import it; the
// discovery keeps the deployed runtime equal to the source by construction.
const sourceOpen = path.join(sourceRoot, "profiles/gabo/opencode")
const runtimeModules = discoverRuntimeModules(sourceOpen)
for (const file of runtimeModules) {
  const destination = path.join(runtime, file)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(sourceOpen, file), destination)
}
fs.copyFileSync(path.join(sourceOpen, "rigel-v2-native.mjs"), path.join(runtime, "index.js"))
const ultraworkSource = fs.readFileSync(path.join(sourceRoot, "packages/prompts-core/prompts/ultrawork/default.md"), "utf8")
// The original prompt targets OmO's V1 `task` tool. V2 reserves that name,
// so the native runtime exposes `rigel_task`; translate only actual calls.
fs.writeFileSync(path.join(runtime, "prompts/ultrawork-default.md"), ultraworkSource.replace(/\btask\(/g, "rigel_task("), { mode: 0o600 })
fs.copyFileSync(agentManifest, path.join(runtime, "rigel-v2-native-agent-manifest.mjs"))
fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
for (const file of ["index.js", ...runtimeModules, "rigel-v2-native-agent-manifest.mjs", "prompts/ultrawork-default.md"]) fs.chmodSync(path.join(runtime, file), 0o600)

const candidate = structuredClone(before)
const plugins = Array.isArray(candidate.plugin) ? candidate.plugin : []
if (state.pluginEntry && plugins.includes(state.pluginEntry)) {
  candidate.plugin = plugins.map((entry) => entry === state.pluginEntry ? runtime : entry)
} else if (!plugins.includes(runtime)) {
  candidate.plugin = [...plugins, runtime]
}
const afterFingerprint = fingerprint(candidate)
if (afterFingerprint.obsidian !== beforeFingerprint.obsidian || afterFingerprint.codexPlugin !== beforeFingerprint.codexPlugin) {
  fail("la activación alteraría un componente protegido")
}
fs.writeFileSync(configFile, JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600 })
state.pluginEntry = runtime
state.protectedFingerprint = protectedFingerprint
state.nativeV2ActivatedAt = new Date().toISOString()
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
console.log("Rigel native OpenCode V2 runtime registered.")
