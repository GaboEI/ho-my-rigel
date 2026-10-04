#!/usr/bin/env node
/**
 * Activates Oh My Rigel for one real-machine trial.
 *
 * This program intentionally refuses to run while OpenCode is live. It never
 * installs, upgrades, or rewrites the two authentication integrations or the
 * Obsidian MCP block; their semantic fingerprints must match the freeze both
 * before and after activation.
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import childProcess from "node:child_process"
import { fileURLToPath } from "node:url"

const home = process.env.HOME || "/home/gabodev"
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const stateRoot = path.join(home, ".local/share/oh-my-rigel")
const snapshot = path.join(stateRoot, "snapshots/20261001-pre-rigel")
const configDir = path.join(home, ".config/opencode")
const configFile = path.join(configDir, "opencode.json")
const frozenConfigFile = path.join(snapshot, "config-opencode/opencode.json")
const omoDir = path.join(home, ".omo")
const distEntry = `file://${path.join(sourceRoot, "dist/index.js")}`
const pluginEntry = path.join(stateRoot, "runtime/omo-v2-plugin")
const runtimeState = path.join(stateRoot, "active-trial.json")
const wrapper = path.join(home, ".local/bin/rigel-opencode")
const rollbackWrapper = path.join(home, ".local/bin/rigel-rollback")

function fail(message) { console.error(`Rigel activation refused: ${message}`); process.exit(1) }
if (process.env.RIGEL_ALLOW_LEGACY_SYSTEM_TRIAL !== "1") {
  fail("el activador histórico está deshabilitado para proteger V1; usa apply-v2-runtime-service.sh para el laboratorio V2")
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function sha(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function hasOpenCodeProcess() {
  try { return childProcess.execFileSync("pgrep", ["-af", `${home}/.opencode/bin/opencode`], { encoding: "utf8" }).trim() }
  catch { return "" }
}
function codexPlugin(config) {
  return (config.plugins || []).find(value => typeof value === "string" && value.startsWith("oc-codex-multi-auth")) || null
}
function protectedFingerprint(config) {
  return { obsidian: sha(config.mcp?.obsidian), codexPlugin: sha(codexPlugin(config)) }
}
function equal(a, b) { return a.obsidian === b.obsidian && a.codexPlugin === b.codexPlugin }
function stageV2Adapter() {
  if (!fs.existsSync(distEntry.slice("file://".length))) fail("no existe el artefacto construido dist/index.js.")
  fs.mkdirSync(pluginEntry, { recursive: true, mode: 0o700 })
  const adapter = fs.readFileSync(path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter.mjs"), "utf8")
    .replaceAll("__OMO_DIST_ENTRY__", distEntry)
  fs.writeFileSync(path.join(pluginEntry, "index.js"), adapter, { mode: 0o600 })
  fs.copyFileSync(
    path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter-core.mjs"),
    path.join(pluginEntry, "omo-v2-adapter-core.mjs"),
  )
  fs.chmodSync(path.join(pluginEntry, "omo-v2-adapter-core.mjs"), 0o600)
}

if (hasOpenCodeProcess()) fail("OpenCode sigue ejecutándose. Ciérralo antes de activar para no corromper sesiones.")
if (!fs.existsSync(frozenConfigFile)) fail("no se encontró la congelación pre-Rigel.")
if (fs.existsSync(runtimeState)) fail("ya existe una prueba Rigel activa; usa rigel-rollback antes de otra activación.")
if (fs.existsSync(omoDir)) fail("~/.omo ya existe; se preserva para evitar mezclar otra configuración OmO.")

const frozen = readJson(frozenConfigFile)
const current = readJson(configFile)
const frozenFingerprint = protectedFingerprint(frozen)
if (!frozen.mcp?.obsidian || !codexPlugin(frozen)) fail("la congelación no contiene los componentes protegidos esperados.")
if (!equal(frozenFingerprint, protectedFingerprint(current))) fail("la configuración activa difiere de la congelación en Obsidian o Codex auth.")
stageV2Adapter()
const skillMaterialization = childProcess.spawnSync(process.execPath, [
  path.join(sourceRoot, "profiles/gabo/materialize-v2-skills.mjs"),
], { cwd: sourceRoot, env: { ...process.env, HOME: home }, encoding: "utf8" })
if (skillMaterialization.status !== 0) fail(`no se pudo exponer las skills V2: ${skillMaterialization.stderr || skillMaterialization.stdout}`)

const tempOmo = `${omoDir}.rigel-stage-${process.pid}`
try {
  fs.mkdirSync(tempOmo, { recursive: true, mode: 0o700 })
  fs.cpSync(path.join(sourceRoot, "profiles/gabo/opencode/agents"), path.join(tempOmo, "opencode/agents"), { recursive: true })
  fs.cpSync(path.join(sourceRoot, "profiles/gabo/opencode/prompts"), path.join(tempOmo, "opencode/prompts"), { recursive: true })
  const profile = fs.readFileSync(path.join(sourceRoot, "profiles/gabo/omo.jsonc"), "utf8")
    .replaceAll("__OMO_PROFILE_ROOT__", omoDir)
  fs.writeFileSync(path.join(tempOmo, "omo.jsonc"), profile, { mode: 0o600 })

  // Textual insertion leaves every existing config block byte-for-byte intact.
  let raw = fs.readFileSync(configFile, "utf8")
  if (!current.plugin?.includes(pluginEntry)) {
    const anchor = '\n  ],\n  "provider":'
    if (!raw.includes(anchor)) fail("la estructura de plugin no coincide con la configuración protegida.")
    raw = raw.replace(anchor, `,\n    ${JSON.stringify(pluginEntry)}\n  ],\n  "default_agent": "sisyphus",\n  "provider":`)
  } else if (!Object.prototype.hasOwnProperty.call(current, "default_agent")) {
    fail("el plugin Rigel ya figura, pero falta default_agent; no se aplicará una edición ambigua.")
  }
  const candidate = JSON.parse(raw)
  if (candidate.default_agent !== "sisyphus") fail("no se pudo seleccionar Sisyphus como agente predeterminado.")
  if (!equal(frozenFingerprint, protectedFingerprint(candidate))) fail("la edición candidata alteraría un componente protegido.")
  fs.renameSync(tempOmo, omoDir)
  fs.writeFileSync(configFile, raw)
  if (!equal(frozenFingerprint, protectedFingerprint(readJson(configFile)))) fail("la escritura alteró un componente protegido; ejecuta rigel-rollback.")

  fs.mkdirSync(path.dirname(wrapper), { recursive: true, mode: 0o700 })
  fs.writeFileSync(wrapper, `#!/usr/bin/env sh\n# Oh My Rigel trial wrapper; remove via rigel-rollback.\nexport OMO_PROFILE=gabo\nexec ${JSON.stringify(path.join(home, ".opencode/bin/opencode"))} "$@"\n`, { mode: 0o700 })
  fs.writeFileSync(rollbackWrapper, `#!/usr/bin/env sh\n# Oh My Rigel trial rollback wrapper.\nexec node ${JSON.stringify(path.join(sourceRoot, "profiles/gabo/rollback-live-trial.mjs"))}\n`, { mode: 0o700 })
  fs.writeFileSync(runtimeState, JSON.stringify({
    activatedAt: new Date().toISOString(), snapshot, pluginEntry, distEntry, profile: "gabo",
    protectedFingerprint: frozenFingerprint, protectedComponents: ["oc-codex-multi-auth", "obsidian"],
    protectedOpenGoRuntime: "/home/gabodev/Documents/Codex/2026-09-29/ho/work/opencode-go-multi-auth-v2/dist/bin.js"
  }, null, 2) + "\n", { mode: 0o600 })
  console.log("Rigel active. Start OpenCode with: rigel-opencode")
  console.log("To restore after closing OpenCode: rigel-rollback")
} catch (error) {
  if (fs.existsSync(tempOmo)) fs.rmSync(tempOmo, { recursive: true, force: true })
  throw error
}
