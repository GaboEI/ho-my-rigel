#!/usr/bin/env node
/** Applies only the proven static V2 agent layer to an active Rigel trial. */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import childProcess from "node:child_process"
import { fileURLToPath } from "node:url"

const home = process.env.HOME || "/home/gabodev"
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const stateRoot = path.join(home, ".local/share/ho-my-rigel")
const stateFile = path.join(stateRoot, "active-trial.json")
const configFile = path.join(home, ".config/opencode/opencode.json")
const generatedFile = path.join(stateRoot, "runtime/v2-generated-agents.json")
const selection = JSON.parse(fs.readFileSync(path.join(sourceRoot, "profiles/gabo/v2-agent-selection.json"), "utf8"))
function fail(message) { console.error(`Rigel V2 agent layer refused: ${message}`); process.exit(1) }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function sha(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function codexPlugin(config) { return (config.plugins || []).find(v => typeof v === "string" && v.startsWith("oc-codex-multi-auth")) || null }
function fingerprint(config) { return { obsidian: sha(config.mcp?.obsidian), codexPlugin: sha(codexPlugin(config)) } }
function hasOpenCode() { try { return childProcess.execFileSync("pgrep", ["-af", `${home}/.opencode/bin/opencode`], { encoding: "utf8" }).trim() } catch { return "" } }

if (hasOpenCode()) fail("OpenCode sigue ejecutándose; el servicio debe estar detenido durante el cambio.")
if (!fs.existsSync(stateFile)) fail("no hay una prueba Rigel activa.")
const state = readJson(stateFile)
const before = readJson(configFile)
const beforeFingerprint = fingerprint(before)
if (beforeFingerprint.obsidian !== state.protectedFingerprint.obsidian || beforeFingerprint.codexPlugin !== state.protectedFingerprint.codexPlugin) fail("un componente protegido no coincide con su huella congelada.")

fs.mkdirSync(path.dirname(generatedFile), { recursive: true, mode: 0o700 })
const generation = childProcess.spawnSync(process.execPath, [
  path.join(sourceRoot, "profiles/gabo/generate-v2-agents.mjs"), "--input", configFile, "--output", generatedFile, "--directory", home,
], { cwd: sourceRoot, env: { ...process.env, HOME: home, OMO_PROFILE: "gabo" }, encoding: "utf8" })
if (generation.status !== 0) fail(`la generación de agentes falló: ${generation.stderr || generation.stdout}`)
const generated = readJson(generatedFile)
const selected = {}
for (const id of selection.orchestratedAgentIds) {
  if (!generated.agent?.[id]) fail(`OmO no generó el agente esperado: ${id}`)
  selected[id] = generated.agent[id]
}
const candidate = structuredClone(before)
candidate.agent = { ...(candidate.agent || {}), ...selected }
for (const id of selection.disabledLegacyAgentIds) candidate.agent[id] = { mode: "subagent", hidden: true }
candidate.default_agent = generated.default_agent
const afterFingerprint = fingerprint(candidate)
if (afterFingerprint.obsidian !== beforeFingerprint.obsidian || afterFingerprint.codexPlugin !== beforeFingerprint.codexPlugin) fail("la capa de agentes alteraría un componente protegido.")
fs.writeFileSync(configFile, JSON.stringify(candidate, null, 2) + "\n")
state.v2AgentLayer = { appliedAt: new Date().toISOString(), defaultAgent: generated.default_agent, agentIds: Object.keys(selected), disabledLegacyAgentIds: selection.disabledLegacyAgentIds }
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify({ defaultAgent: generated.default_agent, installedAgents: Object.keys(selected), disabledLegacy: selection.disabledLegacyAgentIds }))
