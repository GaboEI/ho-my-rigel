#!/usr/bin/env node
/** Restores the exact pre-Rigel config/data freeze after OpenCode is closed. */
import fs from "node:fs"
import path from "node:path"
import childProcess from "node:child_process"

const home = process.env.HOME || "/home/gabodev"
const stateRoot = path.join(home, ".local/share/ho-my-rigel")
const snapshot = path.join(stateRoot, "snapshots/20261001-pre-rigel")
const runtimeState = path.join(stateRoot, "active-trial.json")
const configDir = path.join(home, ".config/opencode")
const dataDir = path.join(home, ".local/share/opencode")
const omoDir = path.join(home, ".omo")
const wrapper = path.join(home, ".local/bin/rigel-opencode")
const rollbackWrapper = path.join(home, ".local/bin/rigel-rollback")

function fail(message) { console.error(`Rigel rollback refused: ${message}`); process.exit(1) }
function hasOpenCodeProcess() {
  try { return childProcess.execFileSync("pgrep", ["-af", `${home}/.opencode/bin/opencode`], { encoding: "utf8" }).trim() }
  catch { return "" }
}
if (hasOpenCodeProcess()) fail("OpenCode sigue ejecutándose. Ciérralo antes de restaurar la congelación.")
if (!fs.existsSync(runtimeState)) fail("no hay una prueba Rigel activa registrada.")
if (!fs.existsSync(path.join(snapshot, "config-opencode")) || !fs.existsSync(path.join(snapshot, "data-opencode"))) fail("la congelación está incompleta.")

const archive = path.join(stateRoot, "trial-archives", new Date().toISOString().replace(/[:.]/g, "-"))
fs.mkdirSync(archive, { recursive: true, mode: 0o700 })
for (const [live, name] of [[configDir, "config-opencode"], [dataDir, "data-opencode"], [omoDir, "omo"]]) {
  if (fs.existsSync(live)) fs.renameSync(live, path.join(archive, name))
}
fs.cpSync(path.join(snapshot, "config-opencode"), configDir, { recursive: true, preserveTimestamps: true })
fs.cpSync(path.join(snapshot, "data-opencode"), dataDir, { recursive: true, preserveTimestamps: true })
if (fs.existsSync(wrapper)) {
  const body = fs.readFileSync(wrapper, "utf8")
  if (body.includes("Ho My Rigel trial wrapper")) fs.unlinkSync(wrapper)
}
if (fs.existsSync(rollbackWrapper)) {
  const body = fs.readFileSync(rollbackWrapper, "utf8")
  if (body.includes("Ho My Rigel trial rollback wrapper")) fs.unlinkSync(rollbackWrapper)
}
fs.unlinkSync(runtimeState)
console.log(`Pre-Rigel environment restored. Trial files preserved in: ${archive}`)
