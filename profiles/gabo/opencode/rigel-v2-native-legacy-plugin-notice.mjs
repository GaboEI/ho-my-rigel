/**
 * Pure detection for the legacy plugin-name notice, ported to the Oh My Rigel
 * V2 companion CLI plugin.
 *
 * V1 owner: packages/omo-opencode/src/hooks/legacy-plugin-toast/{hook.ts,auto-migrate.ts}
 *
 * V2 contract difference: the host config is normalised IN MEMORY and MUST NOT
 * be rewritten. V1 read `opencode.json[c]`, migrated the plugin entry on disk,
 * then announced the result. This module ports ONLY detection plus the notice
 * text: it never reads, writes, or migrates a config file, and the caller
 * supplies the already-loaded in-memory config.
 *
 * The V1 identity (`oh-my-opencode` -> `oh-my-openagent`) is a stable
 * compatibility contract, so the names live here rather than being re-derived.
 */

/** V1 `LEGACY_PLUGIN_NAME` (packages/omo-opencode/src/shared/plugin-identity.ts). */
export const LEGACY_PLUGIN_NAME = "oh-my-opencode"

/** V1 `PLUGIN_NAME` / `PUBLISHED_PACKAGE_NAME` (canonical identity). */
export const PLUGIN_NAME = "oh-my-openagent"

/** V1 toast body, ported verbatim. */
export const LEGACY_NOTICE_TITLE = "Legacy Plugin Name Detected"
export const LEGACY_NOTICE_VARIANT = "warning"
export const LEGACY_NOTICE_DURATION = 10000
export const LEGACY_NOTICE_MESSAGE =
  `Update your opencode.json: "${LEGACY_PLUGIN_NAME}" has been renamed to "${PLUGIN_NAME}".\n` +
  `Run: bunx ${PLUGIN_NAME} install`

/**
 * Resolve the package name carried by a host plugin entry. The V2 config
 * accepts either a bare string (`"oh-my-openagent"`) or a tuple
 * (`["oh-my-openagent", { ... }]`), mirroring V1 `getPluginEntryName`.
 */
export function pluginEntryName(entry) {
  if (Array.isArray(entry)) {
    return typeof entry[0] === "string" ? entry[0] : ""
  }
  return typeof entry === "string" ? entry : ""
}

function isLegacyName(name) {
  return name === LEGACY_PLUGIN_NAME || name.startsWith(`${LEGACY_PLUGIN_NAME}@`)
}

/**
 * Detect legacy `oh-my-opencode` / `oh-my-opencode@*` entries in an in-memory
 * host config. Canonical entries (`oh-my-openagent` / `oh-my-openagent@*`) and
 * unrelated plugin names are never reported.
 *
 * Returns `{ legacy, entries }`. `legacy` is true when at least one legacy entry
 * exists; `entries` lists the matching legacy entry names in config order.
 * Tolerant by design so a shapeshifted host config can never throw here.
 */
export function detectLegacyPluginEntry(config) {
  const plugins = config && typeof config === "object" && Array.isArray(config.plugin) ? config.plugin : []
  const entries = []
  for (const entry of plugins) {
    const name = pluginEntryName(entry)
    if (isLegacyName(name)) entries.push(name)
  }
  return { legacy: entries.length > 0, entries }
}
