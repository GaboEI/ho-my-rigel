#!/usr/bin/env node
/**
 * Exposes the Rigel profile skills through OpenCode V2's native global
 * discovery directory.  V2 watches ~/.agents/skills, not
 * ~/.config/opencode/skills.
 *
 * Existing user-owned entries are never overwritten.  Legacy OpenCode skills
 * are linked into the V2 surface when there is no collision; Rigel-provided
 * skills are linked from this checkout.  The manifest makes every managed
 * entry auditable and lets a future uninstall remove only Rigel-owned links.
 */
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const home = process.env.HOME || os.homedir()
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const rigelSkills = path.join(sourceRoot, "profiles/gabo/skills")
const legacySkills = path.join(home, ".config/opencode/skills")
const targetRoot = path.join(home, ".agents/skills")
const stateDir = path.join(home, ".local/share/oh-my-rigel")
const stateFile = path.join(stateDir, "skills-v2.json")

function isSkill(directory) {
  return fs.existsSync(path.join(directory, "SKILL.md"))
}
function entryExists(candidate) {
  try { fs.lstatSync(candidate); return true } catch { return false }
}
function pointsAt(target, source) {
  try { return fs.realpathSync(target) === fs.realpathSync(source) } catch { return false }
}
function listSkills(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isSkill(path.join(directory, entry.name)))
    .map(entry => entry.name)
    .sort()
}
function link(source, target) {
  fs.symlinkSync(source, target, "dir")
}

fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
const managed = []
const preserved = []
const linkedTargets = new Set()

// Keep the user's pre-Rigel skill inventory usable in OpenCode V2.  These are
// deliberately *not* copied into the fork: their source remains user-owned.
for (const name of listSkills(legacySkills)) {
  const source = path.join(legacySkills, name)
  const target = path.join(targetRoot, name)
  if (entryExists(target)) {
    if (pointsAt(target, source)) {
      managed.push({ name, source, kind: "legacy-bridge" })
      linkedTargets.add(name)
    } else preserved.push(name)
    continue
  }
  link(source, target)
  managed.push({ name, source, kind: "legacy-bridge" })
  linkedTargets.add(name)
}

// Rigel skills fill the remaining names.  A user skill with the same name
// always wins, which avoids silently changing an established workflow.
for (const name of listSkills(rigelSkills)) {
  if (linkedTargets.has(name)) continue
  const source = path.join(rigelSkills, name)
  const target = path.join(targetRoot, name)
  if (entryExists(target)) {
    if (pointsAt(target, source)) managed.push({ name, source, kind: "rigel" })
    else preserved.push(name)
    continue
  }
  link(source, target)
  managed.push({ name, source, kind: "rigel" })
}

fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 })
fs.writeFileSync(stateFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  discoveryRoot: targetRoot,
  managed,
  preserved: [...new Set(preserved)].sort(),
}, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify({ discoveryRoot: targetRoot, linked: managed.map(item => item.name), preserved: [...new Set(preserved)].sort() }))
