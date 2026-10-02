/**
 * Isolation guard for every OpenCode V2 process launched by this profile.
 *
 * Boundary: `.omo/rules/protect-opencode-v1.md`. A process is V2-safe only when
 * its complete home, config, data, state, cache, goal-state, socket and plugin
 * state are inside a disposable sandbox and cannot resolve to the user's real
 * (production V1) OpenCode surfaces. Launching OpenCode with an inherited
 * `{ ...process.env }` is forbidden: the 2026-10-03 incident corrupted V1 goal
 * state exactly that way.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REAL_HOME = os.homedir()

export const PROTECTED_V1_ROOTS = [
  path.join(REAL_HOME, ".config/opencode"),
  path.join(REAL_HOME, ".local/share/opencode"),
  path.join(REAL_HOME, ".local/share/opencode-goal-plugin"),
  path.join(REAL_HOME, ".cache/opencode"),
]

// State-bearing variables that must never be inherited from the launching
// environment: they can point at production V1 even when HOME is replaced.
const STATE_ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_GOAL_STATE_PATH",
  "OMO_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
]

// Any variable under these prefixes is owned by the sandbox builder. An
// inherited OPENCODE_* variable (for example the production account store
// `OPENCODE_MULTI_AUTH_STORE_DIR`) must never reach a harness-spawned child.
const STATE_ENV_PREFIXES = ["OPENCODE_", "OMO_", "XDG_", "SENPI_", "PI_"]

// Environment that is safe to inherit: it selects an interpreter, locale or
// terminal, never a persistent state root.
const INHERIT_ALLOWLIST = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "SHELL", "USER", "LOGNAME", "PWD", "TMPDIR", "NODE_OPTIONS", "BUN_INSTALL"])

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function pointsIntoRealHome(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return false
  const candidate = path.resolve(value)
  return candidate === REAL_HOME || candidate.startsWith(REAL_HOME + path.sep)
}

function pointsIntoProtectedRoot(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return false
  const candidate = path.resolve(value)
  return PROTECTED_V1_ROOTS.some((root) => candidate === root || candidate.startsWith(root + path.sep))
}

/**
 * Builds an environment whose every state root lives under `sandbox`.
 * `home` optionally overrides the sandbox home directory.
 */
export function buildIsolatedV2Env({ sandbox, home = path.join(sandbox, "home"), extra = {} } = {}) {
  if (typeof sandbox !== "string" || sandbox.length === 0) throw new Error("buildIsolatedV2Env requires a sandbox directory")
  const sandboxRoot = path.resolve(sandbox)
  if (inside(REAL_HOME, sandboxRoot) && sandboxRoot !== REAL_HOME) {
    throw new Error(`refusing isolation inside the real home: ${sandboxRoot}`)
  }
  const env = { ...process.env }
  const stripped = []
  for (const key of Object.keys(env)) {
    const owned = STATE_ENV_KEYS.includes(key) || STATE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    if (owned) { stripped.push(key); delete env[key]; continue }
    if (INHERIT_ALLOWLIST.has(key)) continue
    if (pointsIntoRealHome(env[key]) || pointsIntoProtectedRoot(env[key])) {
      stripped.push(key)
      delete env[key]
    }
  }
  const isolated = {
    ...env,
    HOME: path.resolve(home),
    XDG_CONFIG_HOME: path.join(sandboxRoot, "config"),
    XDG_DATA_HOME: path.join(sandboxRoot, "data"),
    XDG_STATE_HOME: path.join(sandboxRoot, "state"),
    XDG_CACHE_HOME: path.join(sandboxRoot, "cache"),
    OPENCODE_GOAL_STATE_PATH: path.join(sandboxRoot, "goal-state", "goals.json"),
    ...extra,
  }
  assertIsolatedV2Env(isolated, { sandbox: sandboxRoot })
  Object.defineProperty(isolated, "__rigelStrippedEnvKeys", { value: stripped, enumerable: false })
  return isolated
}

/**
 * Positive proof of isolation. Throws on the first violation; returns a
 * report that can be written to evidence before the process starts.
 */
export function assertIsolatedV2Env(env, { sandbox } = {}) {
  const sandboxRoot = path.resolve(sandbox)
  const checks = [
    ["HOME", env.HOME],
    ["XDG_CONFIG_HOME", env.XDG_CONFIG_HOME],
    ["XDG_DATA_HOME", env.XDG_DATA_HOME],
    ["XDG_STATE_HOME", env.XDG_STATE_HOME],
    ["XDG_CACHE_HOME", env.XDG_CACHE_HOME],
    ["OPENCODE_GOAL_STATE_PATH", env.OPENCODE_GOAL_STATE_PATH],
  ]
  const report = []
  for (const [key, value] of checks) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`isolation violation: ${key} is unset`)
    const resolved = path.resolve(value)
    if (!inside(sandboxRoot, resolved)) throw new Error(`isolation violation: ${key}=${resolved} escapes the sandbox ${sandboxRoot}`)
    if (resolved === REAL_HOME || (!inside(resolved, REAL_HOME) && inside(REAL_HOME, resolved) && resolved !== REAL_HOME)) {
      throw new Error(`isolation violation: ${key}=${resolved} resolves into the real home`)
    }
    for (const protectedRoot of PROTECTED_V1_ROOTS) {
      if (resolved === protectedRoot || inside(protectedRoot, resolved)) {
        throw new Error(`isolation violation: ${key}=${resolved} touches protected V1 surface ${protectedRoot}`)
      }
    }
    report.push(`${key}=${resolved}`)
  }
  const goalState = path.resolve(env.OPENCODE_GOAL_STATE_PATH)
  if (goalState === path.join(REAL_HOME, ".local/share/opencode-goal-plugin/goals.json")) {
    throw new Error("isolation violation: goal state resolves to the production V1 goal store")
  }
  return { sandbox: sandboxRoot, realHome: REAL_HOME, checks: report }
}

/** Convenience for contracts: build env + write the proof next to the run. */
export function buildIsolatedV2EnvWithEvidence({ sandbox, home, extra, evidenceSink } = {}) {
  const env = buildIsolatedV2Env({ sandbox, home, extra })
  const report = assertIsolatedV2Env(env, { sandbox })
  if (typeof evidenceSink === "function") evidenceSink(report)
  else if (typeof evidenceSink === "string") {
    fs.mkdirSync(path.dirname(evidenceSink), { recursive: true, mode: 0o700 })
    fs.writeFileSync(evidenceSink, `${report.checks.join("\n")}\n`, { mode: 0o600 })
  }
  return env
}

export { REAL_HOME }
