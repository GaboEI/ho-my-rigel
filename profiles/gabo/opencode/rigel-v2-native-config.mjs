/**
 * Native OpenCode V2 configuration resolution for Oh My Rigel.
 *
 * Resolves the harness-neutral `omo.jsonc` chain into the plugin-facing keys that
 * gate the Phase 3 tool and category slices: `monitor.enabled`, `goal.enabled`,
 * `experimental.task_system`, the disabled tool/agent/skill denylists, and the
 * user category records.
 *
 * This is a runtime-only port. The isolated V2 laboratory stages the native
 * runtime as a flat directory with no `node_modules`, so it cannot import the
 * TypeScript config-core packages or `zod`. Every algorithm here is ported from
 * the real owners and the port is pinned against them by
 * `rigel-v2-native-config.parity.test.mjs`:
 *
 *   - packages/omo-config-core/src/loader/paths.ts        (layer discovery)
 *   - packages/omo-config-core/src/loader/merge.ts        (pollution-safe merge)
 *   - packages/omo-config-core/src/loader/resolution.ts   (harness/profile fold)
 *   - packages/omo-config-core/src/schema/config.ts       (layer key contract)
 *   - packages/omo-config-core/src/schema/category.ts     (category key contract)
 *   - packages/omo-config-core/src/schema/legacy-category-names.ts
 *   - packages/omo-opencode/src/plugin-config/omo-config-chain.ts (view assembly)
 *   - packages/omo-opencode/src/plugin-config/config-merger.ts    (union/deep-merge)
 *   - packages/omo-opencode/src/config/validate.ts        (per-key parse, defaults, migration)
 *   - packages/omo-opencode/src/config/schema/{monitor,goal,experimental}.ts
 *   - packages/omo-opencode/src/shared/task-system-enabled.ts
 *
 * Only Node built-ins are imported.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"

/** Monitor gate defaults, from config/schema/monitor.ts. */
export const NATIVE_MONITOR_DEFAULTS = Object.freeze({
  enabled: false,
  live_mode_enabled: false,
  max_monitors_per_session: 3,
  max_runtime_ms: 1800000,
  batch_max_lines: 50,
  batch_max_bytes: 16384,
  flush_interval_ms: 1000,
  ring_max_lines: 1000,
  line_max_bytes: 8192,
  pattern_max_length: 512,
})

/** Goal gate defaults, from config/schema/goal.ts. */
export const NATIVE_GOAL_DEFAULTS = Object.freeze({
  enabled: false,
  auto_start: false,
  default_max_iterations: 100,
})

// Known top-level keys of OmoConfigLayerSchema (config.ts). Anything else at the
// top level of an omo.jsonc layer is stripped by the real loader, so it must not
// reach the plugin view here either.
const LAYER_KEYS = new Set([
  "formatOnMutation", "gateway", "$schema", "categories", "agents", "git_master", "disabled_mcps", "mcp_env_allowlist",
  "task", "teams", "models", "model_profiles", "model_profile", "memory",
  "telemetry", "computer", "disabled_skills", "[opencode]", "[native]", "[senpi]",
  "[codex]", "[omo]", "profiles", "_migrations", "legacy_migrations",
])
// Block keys of OmoConfigLayerSchema / OmoConfigProfileSchema.
const HARNESS_BLOCK_KEYS = new Set(["[opencode]", "[native]", "[senpi]", "[codex]", "[omo]"])
// Keys omo-config-chain.ts deliberately drops from the plugin base view.
const NON_PLUGIN_FIELDS = new Set(["legacy_migrations", "models", "task", "teams"])
// Known keys of OmoConfigProfileSchema, reduced to the ones this resolver reads.
const PROFILE_KEYS = new Set(["categories", "disabled_skills", "[opencode]", "[native]", "[senpi]", "[codex]"])

const TARGET_KEYS = new Set([
  "monitor", "goal", "experimental", "team_mode", "skills", "disabled_tools", "disabled_agents", "disabled_mcps",
  "disabled_skills", "categories", "ralph_loop", "hashline_edit",
])

const MAX_PROJECT_CONFIG_DIRECTORY_DEPTH = 256

const STRING_ARRAY_KEYS = new Set(["disabled_tools", "disabled_agents", "disabled_skills", "disabled_mcps", "mcp_env_allowlist"])

const DEFAULT_READ_FILE_SYSTEM = {
  existsSync,
  lstatSync,
  readFileSync: (path) => readFileSync(path, "utf-8"),
  realpathSync,
}

const ACCOUNT_HOME_DIR = userInfo().homedir

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.prototype.toString.call(value) === "[object Object]"
}

function isUnsafeObjectKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype"
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry))
  if (!isPlainRecord(value)) return value
  const sanitized = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isUnsafeObjectKey(key)) continue
    sanitized[key] = sanitizeValue(entry)
  }
  return sanitized
}

/** Port of omo-config-core loader/merge.ts mergeOmoConfigRecords. */
function mergeRecords(base, override) {
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (isUnsafeObjectKey(key)) continue
    const safeValue = sanitizeValue(value)
    const baseValue = result[key]
    result[key] = isPlainRecord(baseValue) && isPlainRecord(safeValue)
      ? mergeRecords(baseValue, safeValue)
      : safeValue
  }
  return result
}

/** Port of packages/utils deepMerge: objects recurse, arrays replace, undefined keeps base. */
function deepMerge(base, override) {
  if (!base && !override) return undefined
  if (!base) return override
  if (!override) return base
  const result = { ...base }
  for (const key of Object.keys(override)) {
    if (isUnsafeObjectKey(key)) continue
    const baseValue = base[key]
    const overrideValue = override[key]
    if (overrideValue === undefined) continue
    result[key] = isPlainRecord(baseValue) && isPlainRecord(overrideValue)
      ? deepMerge(baseValue, overrideValue)
      : overrideValue
  }
  return result
}

/** Port of mergeUniqueStrings: first-seen order, deduped. */
function mergeUniqueStrings(base, override) {
  return [...new Set([...(base ?? []), ...(override ?? [])])]
}

function removeTrailingCommas(text) {
  let out = ""
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") {
        out += text[index + 1] ?? ""
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ",") {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1
      if (text[lookahead] === "}" || text[lookahead] === "]") continue
    }
    out += char
  }
  return out
}

function stripComments(text) {
  let out = ""
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") {
        out += text[index + 1] ?? ""
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

function readJsonc(text) {
  return JSON.parse(removeTrailingCommas(stripComments(text)))
}

function resolveHomeDir(env) {
  const homeDir = env?.HOME ?? env?.USERPROFILE ?? process.cwd()
  return resolve(homeDir)
}

function isSymlinkedProjectPath(path, fileSystem) {
  if (fileSystem.lstatSync === undefined || !fileSystem.existsSync(path)) return false
  try {
    return fileSystem.lstatSync(path).isSymbolicLink()
  } catch (error) {
    if (error instanceof Error) return true
    throw error
  }
}

function isLoadableProjectConfigFile(path, fileSystem) {
  return fileSystem.existsSync(path) && !isSymlinkedProjectPath(path, fileSystem)
}

function detectProjectConfigPath(dir, fileSystem) {
  const omoDir = join(dir, ".omo")
  if (isSymlinkedProjectPath(omoDir, fileSystem)) return null
  const jsoncPath = join(omoDir, "omo.jsonc")
  if (isLoadableProjectConfigFile(jsoncPath, fileSystem)) return jsoncPath
  const jsonPath = join(omoDir, "omo.json")
  return isLoadableProjectConfigFile(jsonPath, fileSystem) ? jsonPath : null
}

function detectUserConfigPath(env, fileSystem) {
  const configDir = join(resolveHomeDir(env), ".omo")
  const jsoncPath = join(configDir, "omo.jsonc")
  if (fileSystem.existsSync(jsoncPath)) return jsoncPath
  const jsonPath = join(configDir, "omo.json")
  return fileSystem.existsSync(jsonPath) ? jsonPath : jsoncPath
}

function realpathOrSelf(path, fileSystem) {
  if (fileSystem.realpathSync === undefined) return path
  try {
    return fileSystem.realpathSync(path)
  } catch {
    return path
  }
}

/** Port of findProjectConfigPathsFarthestFirst (paths.ts). */
function findProjectConfigPathsFarthestFirst(cwd, homeDir, fileSystem, accountHomeDir) {
  const startDir = resolve(cwd)
  const boundaryDirs = [...new Set([resolve(homeDir), resolve(accountHomeDir)])]
  const realBoundaryDirs = new Set(boundaryDirs.map((path) => realpathOrSelf(path, fileSystem)))
  const nearestFirst = []
  let currentDir = startDir

  for (let depth = 0; depth < MAX_PROJECT_CONFIG_DIRECTORY_DEPTH; depth += 1) {
    const isHomeDir = boundaryDirs.includes(currentDir) || realBoundaryDirs.has(realpathOrSelf(currentDir, fileSystem))
    const configPath = isHomeDir ? null : detectProjectConfigPath(currentDir, fileSystem)
    if (configPath !== null) nearestFirst.push(configPath)
    if (isHomeDir) break
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  return nearestFirst.reverse()
}

/** Port of resolveOmoConfigPaths (paths.ts). */
function resolveLayerPaths({ cwd, env, fileSystem }) {
  const userPath = detectUserConfigPath(env, fileSystem)
  const projectPaths = findProjectConfigPathsFarthestFirst(cwd, resolveHomeDir(env), fileSystem, ACCOUNT_HOME_DIR)
  return [
    { path: userPath, scope: "user" },
    ...projectPaths.map((path) => ({ path, scope: "project" })),
  ]
}

function resolveProfileName(env) {
  const value = env?.OMO_PROFILE || env?.OCX_PROFILE
  if (typeof value === "string" && value.length > 0) return value
  const opencodeConfigDir = env?.OPENCODE_CONFIG_DIR
  const match = typeof opencodeConfigDir === "string"
    ? /(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]*$/.exec(opencodeConfigDir)
    : null
  return match?.[1] && match[1].length > 0 ? match[1] : undefined
}

function withoutControlKeys(config) {
  const result = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === "profiles" || HARNESS_BLOCK_KEYS.has(key)) continue
    result[key] = value
  }
  return result
}

/** Port of resolution.ts harnessLayer: lift `[opencode]` (canonical harness) to top level. */
function harnessLayer(config, harness) {
  if (harness !== "opencode") return {}
  return isPlainRecord(config["[opencode]"]) ? { ...config["[opencode]"] } : {}
}

/** Port of resolveOmoConfigView (resolution.ts), reduced to the OpenCode harness. */
function resolveOmoConfigView(config, harness, profileName) {
  const profiles = isPlainRecord(config.profiles) ? config.profiles : undefined
  const profile = profileName !== undefined && profiles !== undefined && isPlainRecord(profiles[profileName])
    ? profiles[profileName]
    : undefined
  const layers = [
    withoutControlKeys(config),
    harnessLayer(config, harness),
    profile === undefined ? {} : withoutControlKeys(profile),
    profile === undefined ? {} : harnessLayer(profile, harness),
  ]
  let resolved = {}
  for (const layer of layers) resolved = mergeRecords(resolved, layer)
  return withoutControlKeys(resolved)
}

function warn(diagnostics, message) {
  diagnostics.push(message)
}

function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function validateMonitor(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: monitor ignored (invalid value)`)
    return undefined
  }
  const parsed = {}
  for (const key of ["enabled", "live_mode_enabled"]) {
    if (!(key in value)) continue
    if (typeof value[key] === "boolean") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: monitor.${key} ignored (invalid value)`)
  }
  const integerBounds = {
    max_monitors_per_session: [1, 16],
    max_runtime_ms: [1000, Number.MAX_SAFE_INTEGER],
    batch_max_lines: [1, Number.MAX_SAFE_INTEGER],
    batch_max_bytes: [1024, Number.MAX_SAFE_INTEGER],
    flush_interval_ms: [250, Number.MAX_SAFE_INTEGER],
    ring_max_lines: [1, Number.MAX_SAFE_INTEGER],
    line_max_bytes: [256, Number.MAX_SAFE_INTEGER],
    pattern_max_length: [1, Number.MAX_SAFE_INTEGER],
  }
  for (const [key, [min, max]] of Object.entries(integerBounds)) {
    if (!(key in value)) continue
    if (intInRange(value[key], min, max)) parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: monitor.${key} ignored (invalid value)`)
  }
  if ("allowed_commands" in value) {
    if (Array.isArray(value.allowed_commands) && value.allowed_commands.every((entry) => typeof entry === "string")) {
      parsed.allowed_commands = [...value.allowed_commands]
    } else {
      warn(diagnostics, `config: ${path}: monitor.allowed_commands ignored (invalid value)`)
    }
  }
  return { ...NATIVE_MONITOR_DEFAULTS, ...parsed }
}

function validateGoal(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: goal ignored (invalid value)`)
    return undefined
  }
  const parsed = {}
  for (const key of ["enabled", "auto_start"]) {
    if (!(key in value)) continue
    if (typeof value[key] === "boolean") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: goal.${key} ignored (invalid value)`)
  }
  if ("default_max_iterations" in value) {
    if (intInRange(value.default_max_iterations, 1, 1000)) parsed.default_max_iterations = value.default_max_iterations
    else warn(diagnostics, `config: ${path}: goal.default_max_iterations ignored (invalid value)`)
  }
  return { ...NATIVE_GOAL_DEFAULTS, ...parsed }
}

function validateExperimental(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: experimental ignored (invalid value)`)
    return undefined
  }
  const parsed = {}
  if ("task_system" in value) {
    if (typeof value.task_system === "boolean") parsed.task_system = value.task_system
    else warn(diagnostics, `config: ${path}: experimental.task_system ignored (invalid value)`)
  }
  if ("max_tools" in value) {
    if (intInRange(value.max_tools, 1, 1000)) parsed.max_tools = value.max_tools
    else warn(diagnostics, `config: ${path}: experimental.max_tools ignored (invalid value)`)
  }
  // V1 migrates experimental.hashline_edit up to the root key; keep the legacy
  // placement readable so an older profile still enables the hashline surface.
  if ("hashline_edit" in value) {
    if (typeof value.hashline_edit === "boolean") parsed.hashline_edit = value.hashline_edit
    else warn(diagnostics, `config: ${path}: experimental.hashline_edit ignored (invalid value)`)
  }
  return parsed
}

function validateTeamMode(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: team_mode ignored (invalid value)`)
    return undefined
  }
  const validated = {}
  if ("enabled" in value && typeof value.enabled !== "boolean") {
    warn(diagnostics, `config: ${path}: team_mode.enabled ignored (invalid value)`)
  } else if ("enabled" in value) {
    validated.enabled = value.enabled
  }
  // tmux visualization gate (rewritten feature): a boolean that rides with the
  // team_mode block so the generator can materialize it into the manifest.
  if ("tmux_visualization" in value && typeof value.tmux_visualization !== "boolean") {
    warn(diagnostics, `config: ${path}: team_mode.tmux_visualization ignored (invalid value)`)
  } else if ("tmux_visualization" in value) {
    validated.tmux_visualization = value.tmux_visualization
  }
  return validated
}

const CATEGORY_STRING_FIELDS = ["description", "model", "variant", "prompt_append"]
const CATEGORY_BOOLEAN_FIELDS = ["is_unstable_agent", "disable", "warn_unavailable"]
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
const TEXT_VERBOSITIES = new Set(["low", "medium", "high"])

function validateCategoryEntry(value, path, categoryName, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: categories.${categoryName} ignored (invalid value)`)
    return undefined
  }
  const parsed = {}
  for (const key of CATEGORY_STRING_FIELDS) {
    if (!(key in value)) continue
    if (typeof value[key] === "string") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.${key} ignored (invalid value)`)
  }
  for (const key of CATEGORY_BOOLEAN_FIELDS) {
    if (!(key in value)) continue
    if (typeof value[key] === "boolean") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.${key} ignored (invalid value)`)
  }
  if ("temperature" in value) {
    if (typeof value.temperature === "number" && value.temperature >= 0 && value.temperature <= 2) parsed.temperature = value.temperature
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.temperature ignored (invalid value)`)
  }
  if ("top_p" in value) {
    if (typeof value.top_p === "number" && value.top_p >= 0 && value.top_p <= 1) parsed.top_p = value.top_p
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.top_p ignored (invalid value)`)
  }
  for (const key of ["max_tokens", "max_prompt_tokens"]) {
    if (!(key in value)) continue
    if (intInRange(value[key], 1, Number.MAX_SAFE_INTEGER)) parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.${key} ignored (invalid value)`)
  }
  if ("maxTokens" in value) {
    if (typeof value.maxTokens === "number") parsed.maxTokens = value.maxTokens
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.maxTokens ignored (invalid value)`)
  }
  if ("reasoningEffort" in value) {
    if (REASONING_EFFORTS.has(value.reasoningEffort)) parsed.reasoningEffort = value.reasoningEffort
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.reasoningEffort ignored (invalid value)`)
  }
  if ("textVerbosity" in value) {
    if (TEXT_VERBOSITIES.has(value.textVerbosity)) parsed.textVerbosity = value.textVerbosity
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.textVerbosity ignored (invalid value)`)
  }
  if ("provider_options" in value) {
    if (isPlainRecord(value.provider_options)) parsed.provider_options = value.provider_options
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.provider_options ignored (invalid value)`)
  }
  if ("thinking" in value) {
    const thinking = value.thinking
    if (isPlainRecord(thinking) && (thinking.type === "enabled" || thinking.type === "disabled")) {
      parsed.thinking = thinking.budgetTokens === undefined || typeof thinking.budgetTokens === "number"
        ? { ...thinking }
        : { type: thinking.type }
    } else {
      warn(diagnostics, `config: ${path}: categories.${categoryName}.thinking ignored (invalid value)`)
    }
  }
  if ("models" in value) {
    if (Array.isArray(value.models)) parsed.models = [...value.models]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.models ignored (invalid value)`)
  }
  if ("fallback_models" in value) parsed.fallback_models = value.fallback_models
  if ("reasoning" in value) {
    if (typeof value.reasoning === "string" || isPlainRecord(value.reasoning)) parsed.reasoning = value.reasoning
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.reasoning ignored (invalid value)`)
  }
  if ("tools" in value) {
    if (isPlainRecord(value.tools) && Object.values(value.tools).every((entry) => typeof entry === "boolean")) {
      parsed.tools = { ...value.tools }
    } else {
      warn(diagnostics, `config: ${path}: categories.${categoryName}.tools ignored (invalid value)`)
    }
  }
  return parsed
}

function validateCategories(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: categories ignored (invalid value)`)
    return undefined
  }
  const parsed = {}
  for (const [name, definition] of Object.entries(value)) {
    const entry = validateCategoryEntry(definition, path, name, diagnostics)
    if (entry !== undefined) parsed[name] = entry
  }
  return parsed
}

/** Port of validate.ts parseConfig: keep only target keys that pass their schema. */
function parseConfigView(view, diagnostics) {
  const parsed = {}
  for (const [key, value] of Object.entries(view.config)) {
    if (!TARGET_KEYS.has(key)) continue
    if (key === "monitor") {
      const section = validateMonitor(value, view.path, diagnostics)
      if (section !== undefined) parsed.monitor = section
    } else if (key === "goal") {
      const section = validateGoal(value, view.path, diagnostics)
      if (section !== undefined) parsed.goal = section
    } else if (key === "experimental") {
      const section = validateExperimental(value, view.path, diagnostics)
      if (section !== undefined) parsed.experimental = section
    } else if (key === "team_mode") {
      const section = validateTeamMode(value, view.path, diagnostics)
      if (section !== undefined) parsed.team_mode = section
    } else if (key === "skills") {
      if (isPlainRecord(value)) parsed.skills = sanitizeValue(value)
      else warn(diagnostics, `config: ${view.path}: skills ignored (invalid value)`)
    } else if (key === "hashline_edit") {
      if (typeof value === "boolean") parsed.hashline_edit = value
      else warn(diagnostics, `config: ${view.path}: hashline_edit ignored (invalid value)`)
    } else if (STRING_ARRAY_KEYS.has(key)) {
      if (Array.isArray(value)) parsed[key] = value.filter((entry) => typeof entry === "string")
      else warn(diagnostics, `config: ${view.path}: ${key} ignored (invalid value)`)
    } else if (key === "categories") {
      const section = validateCategories(value, view.path, diagnostics)
      if (section !== undefined) parsed.categories = section
    } else if (key === "ralph_loop") {
      if (isPlainRecord(value)) parsed.ralph_loop = value
    }
  }
  return parsed
}

/** Port of config-merger.ts mergeConfigs reduced to the exposed keys. */
function mergeConfigViews(base, override) {
  return {
    ...base,
    ...override,
    disabled_tools: mergeUniqueStrings(base.disabled_tools, override.disabled_tools),
    disabled_agents: mergeUniqueStrings(base.disabled_agents, override.disabled_agents),
    disabled_skills: mergeUniqueStrings(base.disabled_skills, override.disabled_skills),
    disabled_mcps: mergeUniqueStrings(base.disabled_mcps, override.disabled_mcps),
    categories: deepMerge(base.categories, override.categories),
  }
}

/** Port of validate.ts migrateRalphLoopConfig. */
function migrateRalphLoop(config) {
  const legacy = config.ralph_loop
  if (!isPlainRecord(legacy)) return config
  const enabled = typeof legacy.enabled === "boolean" ? legacy.enabled : undefined
  const defaultMaxIterations = typeof legacy.default_max_iterations === "number" ? legacy.default_max_iterations : undefined
  if (enabled === undefined && defaultMaxIterations === undefined) return config
  const existingGoal = config.goal
  return {
    ...config,
    goal: {
      enabled: existingGoal?.enabled ?? enabled ?? false,
      auto_start: existingGoal?.auto_start ?? false,
      default_max_iterations: existingGoal?.default_max_iterations ?? defaultMaxIterations ?? 100,
    },
  }
}

function canonicalCategoryName(name) {
  return name === "deep" ? "deep-low" : name
}

/** Port of canonicalizeCategoriesRecord: rename `deep`, drop a legacy collision. */
function canonicalizeCategoriesRecord(categories) {
  const result = {}
  for (const [name, definition] of Object.entries(categories)) {
    const canonical = canonicalCategoryName(name)
    if (canonical === name) {
      result[name] = definition
      continue
    }
    if (!Object.hasOwn(categories, canonical)) result[canonical] = definition
  }
  return result
}

function baseLayerView(layer) {
  const result = {}
  for (const [key, value] of Object.entries(layer)) {
    if (key === "profiles" || HARNESS_BLOCK_KEYS.has(key) || NON_PLUGIN_FIELDS.has(key)) continue
    result[key] = value
  }
  return result
}

function blockView(layer) {
  return isPlainRecord(layer["[opencode]"]) ? { ...layer["[opencode]"] } : {}
}

function profileRecord(layer, profileName) {
  if (profileName === undefined || !isPlainRecord(layer.profiles)) return {}
  const selected = layer.profiles[profileName]
  if (!isPlainRecord(selected)) return {}
  const result = {}
  for (const key of PROFILE_KEYS) {
    if (key in selected) result[key] = selected[key]
  }
  return result
}

function validateLayer(raw, source, diagnostics) {
  if (!isPlainRecord(raw)) {
    warn(diagnostics, `config: ${source.path}: layer ignored (not an object)`)
    return undefined
  }
  const layer = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!LAYER_KEYS.has(key)) continue
    if (key === "[opencode]" || key === "[native]" || key === "[senpi]" || key === "[codex]" || key === "[omo]") {
      if (isPlainRecord(value)) layer[key] = value
      continue
    }
    if (key === "categories") {
      const categories = validateCategories(value, source.path, diagnostics)
      if (categories !== undefined) layer.categories = canonicalizeCategoriesRecord(categories)
      continue
    }
    if (key === "disabled_skills") {
      if (Array.isArray(value)) layer.disabled_skills = value.filter((entry) => typeof entry === "string")
      else warn(diagnostics, `config: ${source.path}: disabled_skills ignored (invalid value)`)
      continue
    }
    if (key === "profiles") {
      if (isPlainRecord(value)) layer.profiles = value
      continue
    }
    layer[key] = value
  }
  return layer
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry)
    return Object.freeze(value)
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry)
    return Object.freeze(value)
  }
  return value
}

/**
 * Resolve the plugin-facing OmO configuration view for the native V2 runtime.
 *
 * @param {{ directory?: string, env?: Record<string, string|undefined>, fileSystem?: object }} [options]
 * @returns {{
 *   monitor: Record<string, unknown>,
 *   goal: { enabled: boolean, auto_start: boolean, default_max_iterations: number },
 *   experimental: { task_system: boolean },
 *   disabled: { tools: string[], agents: string[], skills: string[] },
 *   disabled_mcps: string[],
 *   mcp_env_allowlist: string[],
 *   categories: Record<string, unknown>,
 *   diagnostics: string[],
 *   sources: { path: string, scope: string, loaded: boolean }[],
 * }}
 */
export function resolveNativePluginConfig(options = {}) {
  const directory = options.directory ?? process.cwd()
  const env = options.env ?? process.env
  const fileSystem = options.fileSystem ?? DEFAULT_READ_FILE_SYSTEM
  const diagnostics = []
  const profileName = resolveProfileName(env)
  const candidates = resolveLayerPaths({ cwd: directory, env, fileSystem })
  const sources = []
  const layers = []
  let userMcpEnvAllowlist = []

  for (const candidate of candidates) {
    if (!fileSystem.existsSync(candidate.path)) {
      sources.push({ path: candidate.path, scope: candidate.scope, loaded: false })
      continue
    }
    let layer
    try {
      layer = validateLayer(readJsonc(fileSystem.readFileSync(candidate.path, "utf-8")), candidate, diagnostics)
    } catch (error) {
      warn(diagnostics, `config: ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`)
      sources.push({ path: candidate.path, scope: candidate.scope, loaded: false })
      continue
    }
    if (layer === undefined) {
      sources.push({ path: candidate.path, scope: candidate.scope, loaded: false })
      continue
    }
    layers.push({ config: layer, path: candidate.path, scope: candidate.scope })
    // V1 security rule: the MCP env allowlist is user-layer only, so a project
    // layer can never extend it. Union comes only from user-scope layers.
    if (Array.isArray(layer.mcp_env_allowlist) && candidate.scope === "user") {
      userMcpEnvAllowlist = [...new Set([...userMcpEnvAllowlist, ...layer.mcp_env_allowlist])]
    }
    sources.push({ path: candidate.path, scope: candidate.scope, loaded: true })
  }

  const views = []
  const pushes = [
    { select: (layer) => baseLayerView(layer), prefix: "" },
    { select: (layer) => blockView(layer), prefix: "[opencode]." },
    { select: (layer) => baseLayerView(profileRecord(layer, profileName)), prefix: profileName === undefined ? "" : `profiles.${profileName}.` },
    { select: (layer) => blockView(profileRecord(layer, profileName)), prefix: profileName === undefined ? "[opencode]." : `profiles.${profileName}.[opencode].` },
  ]
  for (const push of pushes) {
    for (const layer of layers) {
      const config = push.select(layer.config)
      if (Object.keys(config).length > 0) views.push({ config, path: layer.path })
    }
  }

  const mergedLayers = layers.reduce((accumulator, layer) => mergeRecords(accumulator, layer.config), {})
  const resolvedView = resolveOmoConfigView(mergedLayers, "opencode", profileName)
  if (isPlainRecord(resolvedView.categories)) {
    // The real loader canonicalizes legacy category names at layer validation, so
    // `deep` never survives into the merged view. Canonicalize here too, before
    // the deep-merge, or the legacy key would be re-introduced by the merge.
    const categories = canonicalizeCategoriesRecord(resolvedView.categories)
    if (Object.keys(categories).length > 0) {
      views.push({ config: { categories }, path: layers[0]?.path ?? directory })
    }
  }

  let config = {}
  for (const view of views) config = mergeConfigViews(config, parseConfigView(view, diagnostics))
  config = migrateRalphLoop(config)

  // Parity with the real OmO loader: when a key is absent from every layer the
  // loader leaves it `undefined`; it does NOT materialize schema defaults into
  // the plugin config view. Emitting synthetic defaults here would diverge from
  // V1, so each gate preserves its absence instead of inventing a value.
  const monitor = config.monitor
  const goal = config.goal
  const view = {
    monitor,
    goal,
    experimental: {
      task_system: config.experimental?.task_system ?? false,
      max_tools: config.experimental?.max_tools,
    },
    team_mode: config.team_mode,
    // Root hashline_edit is authoritative; the legacy experimental placement is
    // folded in when the root key is absent, mirroring V1's config migration.
    hashline_edit: config.hashline_edit === true || config.experimental?.hashline_edit === true,
    disabled: {
      tools: config.disabled_tools ?? [],
      agents: config.disabled_agents ?? [],
      skills: config.disabled_skills ?? [],
    },
    disabled_mcps: config.disabled_mcps ?? [],
    // User-layer only (V1 parity): never merged from project layers.
    mcp_env_allowlist: userMcpEnvAllowlist,
    categories: config.categories ?? {},
    diagnostics,
    sources,
  }
  return deepFreeze(view)
}

// --- Native V2 gate reader (Task 15 aggregator contract) ---
// Reads materialized gates from the generated agent manifest so a tool
// family is registered only when its gate is enabled. Distinct from
// resolveNativePluginConfig (which reads omo.jsonc directly).
const GATE_KEYS = Object.freeze(["monitor", "goal", "task_system", "team_mode", "interactive_bash", "hashline_edit"])

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Read the materialized feature gates from a manifest. Returns a frozen record
 * with every known gate present as a boolean; an absent or malformed gate is
 * `false`. Unknown keys are ignored so a newer generator can add gates without
 * breaking an older runtime.
 */
export function readNativeGates(manifest) {
  const gates = isPlainObject(manifest?.metadata?.global?.gates) ? manifest.metadata.global.gates : {}
  const resolved = {}
  for (const key of GATE_KEYS) resolved[key] = gates[key] === true
  return Object.freeze(resolved)
}

/**
 * Read the user-declared categories materialized by the generator. Returns a
 * plain object (never the manifest's live reference) so a caller cannot mutate
 * the manifest. Absent or malformed data yields `{}`.
 */
export function readUserCategories(manifest) {
  const categories = manifest?.metadata?.global?.categories
  return isPlainObject(categories) ? { ...categories } : {}
}

/**
 * Read the materialized denylists (tools / agents / skills) the generator wrote
 * from the resolved config view. Returns normalized string arrays; absent or
 * malformed data yields empty arrays so a caller can never crash on a manifest.
 */
export function readNativeDisabled(manifest) {
  const raw = manifest?.metadata?.global?.disabled
  const source = isPlainObject(raw) ? raw : {}
  const normalize = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
  return {
    tools: normalize(source.tools),
    agents: normalize(source.agents),
    skills: normalize(source.skills),
  }
}

/**
 * Read the materialized `experimental.max_tools` cap. Returns undefined when
 * unset (no trimming) or when the manifest carries a non-integer value, so the
 * trimming caller can treat "unset" and "invalid" the same way: no cap.
 */
export function readNativeTmuxVisualization(manifest) {
  return manifest?.metadata?.global?.tmuxVisualization === true
}

export function readNativeMcpPolicy(manifest) {
  const raw = manifest?.metadata?.global?.mcp
  const source = isPlainObject(raw) ? raw : {}
  const normalize = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
  return { disabled: normalize(source.disabled), envAllowlist: normalize(source.envAllowlist) }
}

export function readNativeMaxTools(manifest) {
  const value = manifest?.metadata?.global?.maxTools
  return Number.isInteger(value) && value >= 1 ? value : undefined
}

/**
 * Convenience predicate for a single gate. Kept separate from
 * `readNativeGates` so a caller that only needs one gate does not allocate the
 * whole record, and so the "unknown gate is off" rule lives in one place.
 */
export function isNativeGateEnabled(manifest, gate) {
  if (!GATE_KEYS.includes(gate)) return false
  return readNativeGates(manifest)[gate] === true
}

/**
 * Derive the materialized `metadata.global.gates` record from a resolved native
 * plugin config view (the inverse of `readNativeGates`). The manifest generator
 * writes exactly this shape so the runtime never parses `omo.jsonc` itself.
 *
 * `interactive_bash` has no `omo.jsonc` key: the V1 gate is pure tmux
 * availability at run time (`interactive-bash-availability.ts` `which("tmux")`).
 * Baking host availability into a portable manifest would be wrong, so this gate
 * only records that the config permits the family (it is not explicitly
 * disabled); the runtime's own tmux probe remains the availability authority.
 */
export function deriveNativeGates(view) {
  const disabledTools = Array.isArray(view?.disabled?.tools) ? view.disabled.tools : []
  return {
    monitor: view?.monitor?.enabled === true,
    goal: view?.goal?.enabled === true,
    task_system: view?.experimental?.task_system === true,
    team_mode: view?.team_mode?.enabled === true,
    interactive_bash: !disabledTools.includes("interactive_bash"),
    hashline_edit: view?.hashline_edit === true,
  }
}

export { GATE_KEYS }
