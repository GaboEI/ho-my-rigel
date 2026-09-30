#!/usr/bin/env node
/** Registers the Rigel V2 setup() adapter for an already active live trial. */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const home = process.env.HOME || "/home/gabodev"
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const stateRoot = path.join(home, ".local/share/ho-my-rigel")
const stateFile = path.join(stateRoot, "active-trial.json")
const configFile = path.join(home, ".config/opencode/opencode.json")
const adapterDir = path.join(stateRoot, "runtime/omo-v2-plugin")
const distEntry = `file://${path.join(sourceRoot, "dist/index.js")}`
function fail(message) { console.error(`Rigel V2 adapter refused: ${message}`); process.exit(1) }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function sha(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function codexPlugin(config) { return (config.plugins || []).find(v => typeof v === "string" && v.startsWith("oc-codex-multi-auth")) || null }
function fingerprint(config) { return { obsidian: sha(config.mcp?.obsidian), codexPlugin: sha(codexPlugin(config)) } }

if (!fs.existsSync(stateFile)) fail("no hay una prueba Rigel activa.")
if (!fs.existsSync(distEntry.slice("file://".length))) fail("no existe dist/index.js.")
const state = readJson(stateFile)
const before = readJson(configFile)
const beforeFingerprint = fingerprint(before)
if (beforeFingerprint.obsidian !== state.protectedFingerprint.obsidian || beforeFingerprint.codexPlugin !== state.protectedFingerprint.codexPlugin) fail("un componente protegido no coincide con su huella congelada.")
if (!(before.plugin || []).includes(state.pluginEntry)) fail("no se encontró el entrypoint Rigel actualmente activo.")
fs.mkdirSync(adapterDir, { recursive: true, mode: 0o700 })
const adapter = fs.readFileSync(path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter.mjs"), "utf8").replaceAll("__OMO_DIST_ENTRY__", distEntry)
fs.writeFileSync(path.join(adapterDir, "index.js"), adapter, { mode: 0o600 })
const raw = fs.readFileSync(configFile, "utf8")
const oldJson = JSON.stringify(state.pluginEntry)
if (!raw.includes(oldJson)) fail("el entrypoint no se puede sustituir textualmente de forma segura.")
const candidateRaw = raw.replace(oldJson, JSON.stringify(adapterDir))
const candidate = JSON.parse(candidateRaw)
const afterFingerprint = fingerprint(candidate)
if (afterFingerprint.obsidian !== beforeFingerprint.obsidian || afterFingerprint.codexPlugin !== beforeFingerprint.codexPlugin) fail("el adaptador alteraría un componente protegido.")
fs.writeFileSync(configFile, candidateRaw)
state.pluginEntry = adapterDir
state.distEntry = distEntry
state.v2AdapterActivatedAt = new Date().toISOString()
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
console.log("Rigel V2 setup() adapter registered.")
