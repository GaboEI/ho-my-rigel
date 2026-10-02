#!/usr/bin/env node
/** Install the native Rigel V2 runtime without loading OmO's V1 plugin API. */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const labRoot = process.env.RIGEL_V2_LAB_ROOT || "/home/gabodev/.local/share/opencode-v2-lab"
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
for (const file of ["rigel-v2-native.mjs", "rigel-v2-native-core.mjs", "rigel-v2-native-prompt.mjs", "rigel-v2-native-categories.mjs", "rigel-v2-category-manifest.mjs", "rigel-v2-native-agents.mjs"]) {
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode", file), path.join(runtime, file === "rigel-v2-native.mjs" ? "index.js" : file))
}
const ultraworkSource = fs.readFileSync(path.join(sourceRoot, "packages/prompts-core/prompts/ultrawork/default.md"), "utf8")
// The original prompt targets OmO's V1 `task` tool. V2 reserves that name,
// so the native runtime exposes `rigel_task`; translate only actual calls.
fs.writeFileSync(path.join(runtime, "prompts/ultrawork-default.md"), ultraworkSource.replace(/\btask\(/g, "rigel_task("), { mode: 0o600 })
fs.copyFileSync(agentManifest, path.join(runtime, "rigel-v2-native-agent-manifest.mjs"))
fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
for (const file of ["index.js", "rigel-v2-native-core.mjs", "rigel-v2-native-prompt.mjs", "rigel-v2-native-categories.mjs", "rigel-v2-category-manifest.mjs", "rigel-v2-native-agents.mjs", "rigel-v2-native-agent-manifest.mjs", "prompts/ultrawork-default.md"]) fs.chmodSync(path.join(runtime, file), 0o600)

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
