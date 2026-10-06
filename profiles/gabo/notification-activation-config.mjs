/**
 * Activation-time resolution for Oh My Rigel session notifications.
 *
 * The V2 companion CLI plugin is inert unless its config is present and
 * `enabled` is true. This module owns that resolution so the activation script
 * stays a thin file copier and the decision is unit-testable without touching
 * the laboratory.
 *
 * V1 gate, ported: the hook is created only when `session-notification` is not
 * in `disabled_hooks`, and an external notifier conflict suppresses it unless
 * `notification.force_enable` is true.
 */

export const NOTIFICATION_PLUGIN_ID = "oh-my-rigel.notification"

/** `cli.json` plugin entry that disables the always-on host notifier. */
export const DISABLED_BUILTIN_NOTIFICATION = "-opencode.notifications"

/** V1 default, from `createSessionNotification`'s merged config. */
export const DEFAULT_IDLE_CONFIRMATION_DELAY = 1500

/** Strip `//` and block comments plus trailing commas from a JSONC document. */
export function stripJsonComments(text) {
  if (typeof text !== "string") return ""
  let output = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        output += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index++
      }
      continue
    }
    if (inString) {
      output += char
      if (char === "\\") {
        index++
        output += text[index] ?? ""
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      inLineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      index++
      continue
    }
    output += char
  }
  return output.replace(/,(\s*[}\]])/g, "$1")
}

export function parseJsonc(text) {
  const stripped = stripJsonComments(text).trim()
  if (stripped.length === 0) return {}
  return JSON.parse(stripped)
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Resolve the effective `[opencode]` config block from an OmO profile
 * document. Accepts an already-merged block (an object carrying `disabled_hooks`
 * or `notification`) unchanged, or the multi-profile document written in
 * `omo.jsonc`.
 */
export function resolveProfileOpenCodeBlock(document, profileName) {
  const root = document && typeof document === "object" ? document : {}
  if (Array.isArray(root.disabled_hooks) || (root.notification && typeof root.notification === "object")) return root
  const profiles = root.profiles && typeof root.profiles === "object" ? root.profiles : undefined
  if (!profiles) return root
  const name = typeof profileName === "string" && profileName.length > 0 ? profileName : "gabo"
  const selected = profiles[name] ?? profiles.gabo ?? Object.values(profiles).find((entry) => entry && typeof entry === "object")
  if (!selected || typeof selected !== "object") return {}
  const opencode = selected["[opencode]"]
  if (opencode && typeof opencode === "object") return opencode
  return selected
}

/**
 * Resolve the plugin options from the effective OmO profile.
 *
 * The binding contract: an absent `notification` block means the companion is
 * never registered and the host builtin is left alone. Only an explicit
 * `notification` block with `enabled: true` (and no blocker) lets the plugin take
 * ownership. `enabledOverride` is the QA seam that forces the gate, but it still
 * requires the block to be present, so an unconfigured profile stays inert.
 */
export function resolveNotificationOptions({ profile, externalNotifierDetected = false, enabledOverride } = {}) {
  const record = profile && typeof profile === "object" ? profile : {}
  const notification = record.notification && typeof record.notification === "object" && !Array.isArray(record.notification)
    ? record.notification
    : undefined
  const configured = notification !== undefined
  const disabledHooks = Array.isArray(record.disabled_hooks) ? record.disabled_hooks : []
  const forceEnable = notification?.force_enable === true
  const hookDisabled = disabledHooks.includes("session-notification")

  let enabled = configured && notification.enabled === true && !hookDisabled && (!externalNotifierDetected || forceEnable)
  if (typeof enabledOverride === "boolean") enabled = configured && enabledOverride

  return {
    configured,
    enabled,
    forceEnable,
    playSound: notification?.play_sound === true,
    soundName: typeof notification?.sound_name === "string" && notification.sound_name.length > 0 ? notification.sound_name : "done",
    idleConfirmationDelay: numberOr(notification?.idle_confirmation_delay, DEFAULT_IDLE_CONFIRMATION_DELAY),
    skipIfIncompleteTodos: notification?.skip_if_incomplete_todos !== false,
    enforceMainSessionFilter: notification?.enforce_main_session_filter !== false,
  }
}

function isOurRuntimeEntry(entry, runtimeDir) {
  if (typeof entry === "string") return entry === runtimeDir
  if (entry && typeof entry === "object") return entry.package === runtimeDir
  return false
}

/**
 * Return a new `cli.json` with our companion plugin registered exactly once
 * (object form carrying the resolved options) and the host's built-in notifier
 * disabled so the two never double-announce - ONLY when the notification config
 * is explicitly present and enabled.
 *
 * When it is absent or disabled, any previous registration and the builtin
 * disable marker are removed, so an unconfigured profile leaves `cli.json`
 * without our entry and with `opencode.notifications` untouched. Idempotent:
 * re-running yields the same array, and unrelated plugins keep their position.
 */
export function registerNotificationCliPlugin(cliConfig, { runtimeDir, options, disableBuiltin = true } = {}) {
  const next = { ...(cliConfig && typeof cliConfig === "object" ? cliConfig : {}) }
  const current = Array.isArray(next.plugins) ? next.plugins : []
  const plugins = current.filter((entry) => {
    if (isOurRuntimeEntry(entry, runtimeDir)) return false
    if (entry === DISABLED_BUILTIN_NOTIFICATION) return false
    return true
  })
  if (options?.enabled === true) {
    plugins.push({ package: runtimeDir, options: { notification: options } })
    if (disableBuiltin) plugins.push(DISABLED_BUILTIN_NOTIFICATION)
  }
  next.plugins = plugins
  return next
}
