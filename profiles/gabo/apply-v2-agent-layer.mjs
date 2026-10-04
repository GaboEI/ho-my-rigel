#!/usr/bin/env node
/**
 * Generates Rigel's native V2 agent manifest. This intentionally never writes
 * ~/.config/opencode: registration happens later through agent.transform.
 */
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import childProcess from "node:child_process"
import { fileURLToPath } from "node:url"

const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const home = process.env.RIGEL_V2_HOME || path.join(labRoot, "home")
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const stateRoot = path.join(labRoot, "rigel")
const stateFile = path.join(stateRoot, "active-trial.json")
const configFile = process.env.RIGEL_V2_CONFIG || path.join(labRoot, "config/opencode/opencode.json")
const output = path.join(stateRoot, "runtime/rigel-v2-agent-manifest.mjs")
const selectionFile = path.join(sourceRoot, "profiles/gabo/v2-agent-selection.json")
const judgeFile = path.join(sourceRoot, "profiles/gabo/opencode/agents/judge.v2.json")
function fail(message) { console.error(`Rigel V2 manifest refused: ${message}`); process.exit(1) }

if (!fs.existsSync(configFile)) fail("no existe la configuración V2 activa")
const selection = JSON.parse(fs.readFileSync(selectionFile, "utf8"))
if (!selection.independentJudge?.id || !fs.existsSync(judgeFile)) fail("la definición del Juez independiente no está disponible")

// Keep the V2 discovery surface in sync as part of the same activation.
// This links user-owned skills; it never rewrites the V1 configuration.
const skills = childProcess.spawnSync(process.execPath, [
  path.join(sourceRoot, "profiles/gabo/materialize-v2-skills.mjs"),
], { cwd: sourceRoot, env: { ...process.env, HOME: home }, encoding: "utf8" })
if (skills.status !== 0) fail(`no se pudieron exponer las skills V2: ${skills.stderr || skills.stdout}`)

fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
const generatorHome = fs.mkdtempSync(path.join(path.dirname(output), "generator-home-"))
const generatorProfile = path.join(generatorHome, ".omo")
fs.mkdirSync(path.join(generatorProfile, "opencode/prompts"), { recursive: true, mode: 0o700 })
// The profile source is overridable for a gates-on QA run; the default stays the
// tracked gabo profile so normal activation is unchanged.
const profileSource = process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc")
fs.writeFileSync(
  path.join(generatorProfile, "omo.jsonc"),
  fs.readFileSync(profileSource, "utf8").replaceAll("__OMO_PROFILE_ROOT__", generatorProfile),
  { mode: 0o600 },
)
fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/prompts/sisyphus-orchestration.md"), path.join(generatorProfile, "opencode/prompts/sisyphus-orchestration.md"))
const generated = childProcess.spawnSync(process.execPath, [
  path.join(sourceRoot, "profiles/gabo/generate-v2-agents.mjs"),
  "--input", configFile, "--output", output,
  "--selection", selectionFile, "--judge", judgeFile,
  "--directory", home, "--profile-root", generatorHome,
], { cwd: sourceRoot, env: { ...process.env, HOME: generatorHome, XDG_CONFIG_HOME: path.dirname(path.dirname(configFile)), OMO_PROFILE: "gabo" }, encoding: "utf8" })
fs.rmSync(generatorHome, { recursive: true, force: true })
if (generated.status !== 0) fail(`la generación del manifiesto falló: ${generated.stderr || generated.stdout}`)
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { activatedAt: new Date().toISOString(), configFile, labRoot, pluginEntry: null }
state.v2AgentManifest = { generatedAt: new Date().toISOString(), output, agentIds: [...selection.orchestratedAgentIds, selection.independentJudge.id] }
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
console.log(generated.stdout.trim())
