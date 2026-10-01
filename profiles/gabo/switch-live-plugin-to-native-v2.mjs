#!/usr/bin/env node
/** Install the native Rigel V2 runtime without loading OmO's V1 plugin API. */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const home = process.env.HOME || "/home/gabodev"
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const stateRoot = path.join(home, ".local/share/ho-my-rigel")
const stateFile = path.join(stateRoot, "active-trial.json")
const configFile = path.join(home, ".config/opencode/opencode.json")
const runtime = path.join(stateRoot, "runtime/rigel-v2-native")

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
if (beforeFingerprint.obsidian !== state.protectedFingerprint.obsidian || beforeFingerprint.codexPlugin !== state.protectedFingerprint.codexPlugin) {
  fail("un componente protegido no coincide con su huella congelada")
}
if (!(before.plugin || []).includes(state.pluginEntry)) fail("no se encontró el entrypoint Rigel activo")

fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
for (const file of ["rigel-v2-native.mjs", "rigel-v2-native-core.mjs", "rigel-v2-native-prompt.mjs"]) {
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode", file), path.join(runtime, file === "rigel-v2-native.mjs" ? "index.js" : file))
}
fs.copyFileSync(path.join(sourceRoot, "packages/prompts-core/prompts/ultrawork/default.md"), path.join(runtime, "prompts/ultrawork-default.md"))
fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
for (const file of ["index.js", "rigel-v2-native-core.mjs", "rigel-v2-native-prompt.mjs", "prompts/ultrawork-default.md"]) fs.chmodSync(path.join(runtime, file), 0o600)

const raw = fs.readFileSync(configFile, "utf8")
const oldEntry = JSON.stringify(state.pluginEntry)
if (!raw.includes(oldEntry)) fail("el entrypoint no se puede sustituir textualmente de forma segura")
const candidateRaw = raw.replace(oldEntry, JSON.stringify(runtime))
const candidate = JSON.parse(candidateRaw)
const afterFingerprint = fingerprint(candidate)
if (afterFingerprint.obsidian !== beforeFingerprint.obsidian || afterFingerprint.codexPlugin !== beforeFingerprint.codexPlugin) {
  fail("la activación alteraría un componente protegido")
}
fs.writeFileSync(configFile, candidateRaw)
state.pluginEntry = runtime
state.nativeV2ActivatedAt = new Date().toISOString()
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
console.log("Rigel native OpenCode V2 runtime registered.")
