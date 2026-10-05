/**
 * Native OpenCode V2 tier-2 MCP loader (correction H5; V1 parity:
 * `features/claude-code-mcp-loader/` over `packages/claude-code-compat-core/`).
 *
 * Loads Claude Code `.mcp.json` MCP declarations from the V1 file list, in
 * order (later files win; `disabled: true` removes a server from any earlier
 * scope), expands `${VAR}` / `${VAR:default}` env references through the
 * user-layer allowlist (a name not in the allowlist expands to its default or
 * to the empty string, never to the ambient value), applies the V1 scope
 * filter (`local` scope requires `projectPath` to contain the cwd), and
 * registers the servers through the official V2 `ctx.mcp.transform` surface
 * using the same translation as the skill-MCP tier-3 loader.
 */

import fsModule from "node:fs"
import os from "node:os"
import { translateSkillMcpConfig } from "./rigel-v2-native-skill-mcp.mjs"

const ENV_REFERENCE_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g

export function expandMcpEnvReferences(value, { env = process.env, isAllowed, onBlocked } = {}) {
  return value.replace(ENV_REFERENCE_PATTERN, (_match, varName, defaultValue) => {
    if (isAllowed && !isAllowed(varName)) {
      onBlocked?.(varName)
      return defaultValue ?? ""
    }
    return env?.[varName] ?? defaultValue ?? ""
  })
}

export function expandMcpEnvReferencesInObject(value, options = {}) {
  if (value == null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((entry) => expandMcpEnvReferencesInObject(entry, options))
  const result = {}
  for (const [key, nested] of Object.entries(value)) {
    result[key] = typeof nested === "string" ? expandMcpEnvReferences(nested, options) : expandMcpEnvReferencesInObject(nested, options)
  }
  return result
}

function mcpConfigPaths({ directory, home, claudeConfigDir }) {
  return [
    { path: `${home}/.claude.json`, scope: "user" },
    { path: `${claudeConfigDir}/.mcp.json`, scope: "user" },
    { path: `${directory}/.mcp.json`, scope: "project" },
    { path: `${directory}/.claude/.mcp.json`, scope: "local" },
  ]
}

function localScopeMatches(server, directory) {
  if (server.scope !== "local") return true
  if (typeof server.projectPath !== "string" || !server.projectPath) return false
  return directory === server.projectPath || server.projectPath === "*" || `${directory}/`.startsWith(`${server.projectPath.replace(/\/+$/, "")}/`)
}

function readMcpConfigFile(path) {
  try {
    return JSON.parse(fsModule.readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/**
 * Load and translate the tier-2 servers. Returns `{ servers, blocked }` where
 * `servers` maps name -> V2 MCP config (`local`/`remote`) and `blocked` lists
 * the env var names whose expansion was refused by the allowlist.
 */
export function loadClaudeCodeMcpServers({
  directory = process.cwd(),
  home,
  claudeConfigDir,
  disabledMcps = [],
  allowlist = [],
  env = process.env,
} = {}) {
  const homeDir = home ?? os.homedir()
  const claudeDir = claudeConfigDir ?? `${homeDir}/.claude`
  const allowSet = new Set(allowlist)
  const blocked = []
  const disabled = new Set(disabledMcps)
  const servers = {}

  for (const { path, scope } of mcpConfigPaths({ directory, home: homeDir, claudeConfigDir: claudeDir })) {
    const config = readMcpConfigFile(path)
    if (!config || typeof config !== "object" || !config.mcpServers || typeof config.mcpServers !== "object") continue

    for (const [name, rawServer] of Object.entries(config.mcpServers)) {
      if (!rawServer || typeof rawServer !== "object") continue
      if (disabled.has(name)) continue
      if (!localScopeMatches(rawServer, directory)) continue
      if (rawServer.disabled === true) {
        delete servers[name]
        continue
      }
      const expanded = expandMcpEnvReferencesInObject(rawServer, {
        env,
        isAllowed: (varName) => allowSet.has(varName),
        onBlocked: (varName) => {
          if (!blocked.includes(varName)) blocked.push(varName)
        },
      })
      const translated = translateSkillMcpConfig(expanded)
      if (!translated) continue
      servers[name] = { ...translated, enabled: translated.enabled !== false }
    }
  }
  return { servers, blocked }
}

/**
 * Register the loaded tier-2 servers on the live V2 host. Servers the host
 * already declares keep precedence (an existing entry is not replaced).
 */
export async function registerClaudeCodeMcps(context, { directory, home, claudeConfigDir, disabledMcps, allowlist } = {}) {
  if (typeof context?.mcp?.transform !== "function") return { registered: [], blocked: [] }
  const { servers, blocked } = loadClaudeCodeMcpServers({ directory, home, claudeConfigDir, disabledMcps, allowlist })
  const registered = []
  await context.mcp.transform((collection) => {
    const existing = new Set((typeof collection.list === "function" ? collection.list() : []).map((entry) => entry?.name).filter(Boolean))
    for (const [name, config] of Object.entries(servers)) {
      if (existing.has(name)) continue
      collection.set(name, config)
      registered.push(name)
    }
  })
  return { registered, blocked }
}
