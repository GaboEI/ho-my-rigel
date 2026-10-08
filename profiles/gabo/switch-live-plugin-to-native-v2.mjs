#!/usr/bin/env node
/** Install the native Rigel V2 runtime without loading OmO's V1 plugin API. */
import os from "node:os"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"
import {
  parseJsonc,
  registerCompanionCliPlugin,
  resolveNotificationOptions,
  resolveProfileOpenCodeBlock,
} from "./notification-activation-config.mjs"

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

// Resolve the notification gate BEFORE writing the runtime package.json: the
// `./tui` export is what makes the host auto-load the companion CLI plugin, so
// it must be absent unless the notification config is explicitly enabled. The
// same options drive the isolated cli.json registration below.
const profileFile = process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc")
let profileDocument = {}
if (fs.existsSync(profileFile)) {
  try {
    profileDocument = parseJsonc(fs.readFileSync(profileFile, "utf8"))
  } catch (error) {
    fail(`no se pudo leer el perfil para la configuración de notificaciones: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const openCodeBlock = resolveProfileOpenCodeBlock(profileDocument, process.env.OMO_PROFILE)
const enabledOverride = process.env.RIGEL_V2_NOTIFICATION_ENABLED === undefined
  ? undefined
  : process.env.RIGEL_V2_NOTIFICATION_ENABLED === "1"
const notificationOptions = resolveNotificationOptions({ profile: openCodeBlock, enabledOverride })

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
// Second entrypoint: the composed companion CLI plugin (`@opencode/plugin/tui`).
// A local plugin directory is resolved by file name (`tui` -> `tui.js`), so it
// is deployed as `tui.js` beside `index.js`. It is always deployed: the
// companion composes several surfaces (notification, legacy-name notice,
// native-edition nudge, task toasts) and each applies its own gate, so an
// unconfigured notification block no longer removes the whole companion.
const cliEntryName = "tui.js"
const cliEntryDestination = path.join(runtime, cliEntryName)
fs.copyFileSync(path.join(sourceOpen, "rigel-v2-native-cli.mjs"), cliEntryDestination)
// Task 12: stage the keyword-detector prompt bodies the native request seam
// reads. The original prompts target OmO's V1 `task` tool, but V2 reserves that
// name and the native runtime exposes `rigel_task`, so translate only actual
// calls. Ultrawork bodies route by the V1 source (planner/gpt/gemini/glm/
// default); team and hyperplan are the V1 mode prompts.
const promptFiles = [
  ["ultrawork-default.md", "packages/prompts-core/prompts/ultrawork/default.md"],
  ["ultrawork-gpt.md", "packages/prompts-core/prompts/ultrawork/gpt.md"],
  ["ultrawork-gemini.md", "packages/prompts-core/prompts/ultrawork/gemini.md"],
  ["ultrawork-glm.md", "packages/prompts-core/prompts/ultrawork/glm.md"],
  ["ultrawork-planner.md", "packages/prompts-core/prompts/ultrawork/planner.md"],
  ["team.md", "packages/prompts-core/prompts/mode/team.md"],
  ["hyperplan.md", "packages/prompts-core/prompts/mode/hyperplan.md"],
]
for (const [name, relative] of promptFiles) {
  const source = fs.readFileSync(path.join(sourceRoot, relative), "utf8")
  fs.writeFileSync(path.join(runtime, "prompts", name), source.replace(/\btask\(/g, "rigel_task("), { mode: 0o600 })
}
// The hyperplan-ultrawork combo banner lives in the V1 detector constants, not
// in a prompt file. Extract it verbatim and fail loudly if the source shape
// changes instead of deploying a combo mode with no banner.
const keywordConstants = fs.readFileSync(path.join(sourceRoot, "packages/omo-opencode/src/hooks/keyword-detector/constants.ts"), "utf8")
const comboBanner = keywordConstants.match(/const HYPERPLAN_ULTRAWORK_BANNER = `([\s\S]*?)`/)?.[1]
if (typeof comboBanner !== "string" || !comboBanner.trim()) {
  fail("no se pudo extraer el banner hyperplan-ultrawork del detector V1")
}
fs.writeFileSync(path.join(runtime, "prompts/ultrawork-combo-banner.md"), `${comboBanner}\n`, { mode: 0o600 })
fs.copyFileSync(agentManifest, path.join(runtime, "rigel-v2-native-agent-manifest.mjs"))
const runtimeExports = { ".": "./index.js", "./tui": `./${cliEntryName}` }
fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: "rigel-v2-native", type: "module", exports: runtimeExports }, null, 2) + "\n", { mode: 0o600 })
for (const file of ["index.js", cliEntryName, ...runtimeModules, "rigel-v2-native-agent-manifest.mjs", ...promptFiles.map(([name]) => `prompts/${name}`), "prompts/ultrawork-combo-banner.md"]) {
  const target = path.join(runtime, file)
  if (fs.existsSync(target)) fs.chmodSync(target, 0o600)
}

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

// Register the composed companion CLI plugin in the isolated CLI config and
// disable the host's always-on built-in notifier - the latter only when the
// notification config is explicitly enabled (resolved above). The companion
// itself is always registered: its non-notification surfaces are default-on and
// gate themselves. An unconfigured profile therefore still leaves the host
// builtin notifier untouched.
const cliConfigFile = path.join(path.dirname(configFile), "cli.json")
const cliBefore = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
const cliAfter = registerCompanionCliPlugin(cliBefore, {
  runtimeDir: runtime,
  options: notificationOptions,
  notificationEnabled: notificationOptions.enabled,
})
fs.writeFileSync(cliConfigFile, JSON.stringify(cliAfter, null, 2) + "\n", { mode: 0o600 })

console.log("Rigel native OpenCode V2 runtime registered.")
console.log(`Rigel companion CLI surfaces registered in ${cliConfigFile} (builtin notifier ${notificationOptions.enabled ? "disabled" : "left untouched"}).`)
