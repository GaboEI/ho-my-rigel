#!/usr/bin/env node
/** Repoints an already active Rigel trial from its development entrypoint to dist. */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const home = process.env.HOME || "/home/gabodev"
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const configFile = path.join(home, ".config/opencode/opencode.json")
const stateFile = path.join(home, ".local/share/ho-my-rigel/active-trial.json")
const distEntry = `file://${path.join(sourceRoot, "dist/index.js")}`
function fail(message) { console.error(`Rigel switch refused: ${message}`); process.exit(1) }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function sha(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function codexPlugin(config) { return (config.plugins || []).find(v => typeof v === "string" && v.startsWith("oc-codex-multi-auth")) || null }
function protectedFingerprint(config) { return { obsidian: sha(config.mcp?.obsidian), codexPlugin: sha(codexPlugin(config)) } }

if (!fs.existsSync(stateFile)) fail("no hay una prueba Rigel activa.")
if (!fs.existsSync(distEntry.slice("file://".length))) fail("no existe dist/index.js; ejecuta la construcción primero.")
const state = readJson(stateFile)
const before = readJson(configFile)
const protectedBefore = protectedFingerprint(before)
if (protectedBefore.obsidian !== state.protectedFingerprint.obsidian || protectedBefore.codexPlugin !== state.protectedFingerprint.codexPlugin) fail("un componente protegido no coincide con su huella congelada.")
if (!(before.plugin || []).includes(state.pluginEntry)) fail("no se encontró el entrypoint Rigel registrado actualmente.")
const raw = fs.readFileSync(configFile, "utf8")
const oldJson = JSON.stringify(state.pluginEntry)
if (!raw.includes(oldJson)) fail("el entrypoint no se puede sustituir textualmente de forma segura.")
const candidateRaw = raw.replace(oldJson, JSON.stringify(distEntry))
const candidate = JSON.parse(candidateRaw)
if (protectedFingerprint(candidate).obsidian !== protectedBefore.obsidian || protectedFingerprint(candidate).codexPlugin !== protectedBefore.codexPlugin) fail("el cambio candidato alteraría un componente protegido.")
fs.writeFileSync(configFile, candidateRaw)
state.pluginEntry = distEntry
state.distributionBuiltAt = new Date().toISOString()
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
console.log("Rigel now points to its built dist/index.js plugin.")
