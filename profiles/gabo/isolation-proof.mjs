/**
 * Prints the positive isolation proof required before any OpenCode launch, and
 * exits non-zero if any resolved state root can reach production V1.
 * Read-only: touches no V1 surface.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildIsolatedV2Env, PROTECTED_V1_ROOTS, REAL_HOME } from "./isolated-v2-env.mjs"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-isolation-proof-"))
const env = buildIsolatedV2Env({ sandbox })
const lines = []
lines.push(`# Isolation proof ${new Date().toISOString()}`)
lines.push(`real_home=${REAL_HOME}`)
lines.push(`sandbox=${sandbox}`)
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_GOAL_STATE_PATH"]) {
  lines.push(`${key}=${env[key]}`)
}
lines.push(`stripped_env=${(env.__rigelStrippedEnvKeys ?? []).join(",")}`)
let leak = false
for (const protectedRoot of PROTECTED_V1_ROOTS) {
  const hits = Object.entries(env).filter(([, value]) => typeof value === "string" && (value === protectedRoot || value.startsWith(protectedRoot + path.sep)))
  const status = hits.length === 0 ? "clean" : `LEAK(${hits.map(([key]) => key).join(",")})`
  if (hits.length > 0) leak = true
  lines.push(`protected[${protectedRoot}]=${status}`)
}
const goalStore = path.join(REAL_HOME, ".local/share/opencode-goal-plugin/goals.json")
lines.push(`goal_state_is_production=${path.resolve(env.OPENCODE_GOAL_STATE_PATH) === goalStore}`)
if (path.resolve(env.OPENCODE_GOAL_STATE_PATH) === goalStore) leak = true
lines.push(leak ? "verdict=UNSAFE" : "verdict=ISOLATED")
process.stdout.write(lines.join("\n") + "\n")
fs.rmSync(sandbox, { recursive: true, force: true })
if (leak) process.exit(1)
