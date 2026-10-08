/**
 * Oh My Rigel OmO Native nudge, V2 companion CLI plugin surface.
 *
 * V1 owners:
 *   packages/omo-opencode/src/hooks/native-edition-nudge/hook.ts        (session toast)
 *   packages/omo-opencode/src/features/native-edition-nudge/tui.ts      (/native dialog)
 *
 * Two surfaces share one durable state store:
 *   - the "hook toast": on `session.created`, run the full decision ladder and
 *     show the mobile-friendly install toast once per process;
 *   - the feature dialog: a keymap command `/native` (alias `omo-native`) that
 *     opens a select dialog offering install | guide | later | never.
 *
 * Effect mapping, V1 -> V2 CLI context:
 *   ctx.client.tui.showToast(...)  -> context.ui.toast.show({ title, message, variant, duration })
 *   api.command.register(...)      -> context.keymap.layer(() => ({ commands }))
 *   api.ui.dialog.replace(...)     -> context.ui.dialog.select({ ... })
 *   root/child session             -> context.data.session.get(sessionID)?.parentID
 *   hook gate + interactivity      -> context.options.nativeEditionNudge.enabled + isInteractiveSession
 *
 * Zero side effects when the feature's config gate is absent: `setup` returns
 * `undefined` and registers nothing and writes nothing. Every effect is
 * contained and logged; a failure never throws into the host.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { extractSessionID } from "./rigel-v2-native-notification-core.mjs"
import {
  NUDGE_SNOOZE_MS,
  decideNativeEditionNudge,
  detectNativeEdition,
  freshNudgeState,
  isInteractiveSession,
} from "./rigel-v2-native-nudge-core.mjs"
import { createNudgeStateStore, resolveNudgeStateDir } from "./rigel-v2-native-nudge-state.mjs"

export const NUDGE_PLUGIN_ID = "oh-my-rigel.native-edition-nudge"

export const NATIVE_NUDGE_DIALOG_TITLE = "OmO Native"
export const NATIVE_NUDGE_TOAST_DURATION = 10000
export const NATIVE_NUDGE_TOAST_TITLE = "Try OmO Native: no host app needed"

/** V1 `formatNativeInstallEntryCommand(resolveNativeInstallPlan(true))`. */
export const NATIVE_INSTALL_ENTRY_COMMAND = "bunx oh-my-openagent install --platform=native"
export const NATIVE_SETUP_COMMAND = "omo setup"
export const NATIVE_EDITION_GUIDE_URL =
  "https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/migrating-from-opencode.md"

export const NATIVE_NUDGE_TOAST_MESSAGE =
  `Same agent, one binary, nothing else to keep updated.\nInstall: ${NATIVE_INSTALL_ENTRY_COMMAND}`

export const NATIVE_NUDGE_OPTIONS = Object.freeze([
  { value: "install", title: "Install OmO Native" },
  { value: "guide", title: "Open the guide" },
  { value: "later", title: "Remind me in a week" },
  { value: "never", title: "Don't ask again" },
])

/**
 * Resolve the feature gate. Mirrors the notification surface: the block must be
 * present and `enabled: true`. An absent block is exactly zero side effects.
 */
export function resolveNativeNudgeConfig(options) {
  const block = options?.nativeEditionNudge
  if (block && typeof block === "object" && !Array.isArray(block) && block.enabled === false) return null
  return { enabled: true, version: block && typeof block === "object" && typeof block.version === "string" && block.version.length > 0 ? block.version : "unknown" }
}

function resolveLogPath(overrides, contextOptions) {
  if (typeof overrides?.logFile === "string" && overrides.logFile.length > 0) return overrides.logFile
  if (typeof contextOptions?.logFile === "string" && contextOptions.logFile.length > 0) return contextOptions.logFile
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "oh-my-rigel", "native-nudge.log")
}

function createLogger(logPath) {
  let active = true
  return {
    log(entry) {
      if (!active) return
      try {
        mkdirSync(dirname(logPath), { recursive: true })
        appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8")
      } catch {
        active = false
      }
    },
  }
}

function readSession(api, sessionID) {
  try {
    return api?.data?.session?.get?.(sessionID)
  } catch {
    return undefined
  }
}

function showToast(api, toast) {
  const surface = api?.ui?.toast
  if (surface && typeof surface.show === "function") surface.show(toast)
  else if (typeof surface === "function") surface(toast)
}

function currentState(store, now) {
  const read = typeof store?.read === "function" ? store.read() : "missing"
  return read === "missing" || read === "corrupt" ? freshNudgeState(now, "cli-nudge") : read
}

/**
 * Apply one dialog action. Ported from V1 `applyNativeEditionNudgeAction`.
 * Returns `{ toast, url? }`; the caller renders the toast.
 */
export function applyNativeEditionNudgeAction(action, options = {}) {
  const now = typeof options.now === "number" ? options.now : Date.now()
  const store = options.store
  const state = currentState(store, now)
  const write = (next) => {
    if (store && typeof store.write === "function") store.write(next)
  }

  if (action === "install") {
    // Handed over, not spawned: a global install has no rollback and this dialog
    // has no progress surface. Nothing is recorded either, so an install that
    // exits 0 without landing never silences the nudge permanently.
    return { toast: `Run: ${NATIVE_INSTALL_ENTRY_COMMAND}\nThen: ${NATIVE_SETUP_COMMAND}` }
  }

  if (action === "guide") {
    write({ ...state, nextEligibleAt: now + NUDGE_SNOOZE_MS, writtenBy: "cli-nudge" })
    return { toast: "Opening the OmO Native guide.", url: NATIVE_EDITION_GUIDE_URL }
  }

  if (action === "later") {
    // A reminder the user asked for is not nagging, so it does NOT count toward
    // the lifetime cap.
    write({ ...state, nextEligibleAt: now + NUDGE_SNOOZE_MS, decision: "snoozed", decidedAt: now, writtenBy: "cli-nudge" })
    return { toast: "I'll mention OmO Native again in a week." }
  }

  write({ ...state, decision: "never", decidedAt: now, writtenBy: "cli-nudge" })
  return { toast: "I won't bring up OmO Native again. The command palette entry stays available." }
}

/** Register the `/native` (alias `omo-native`) command layer on the TUI keymap. */
function registerNativeCommand(api, run, logger) {
  const keymap = api?.keymap
  if (!keymap || typeof keymap !== "object") return undefined
  const layer = {
    commands: [
      {
        id: "omo.native.nudge",
        title: NATIVE_NUDGE_DIALOG_TITLE,
        value: "omo.native.nudge",
        description: "Install the standalone OmO Native edition, or stop being reminded about it",
        category: "Session",
        enabled: true,
        slash: { name: "native", aliases: ["omo-native"] },
        onSelect: run,
        run,
      },
    ],
  }
  try {
    if (typeof keymap.layer === "function") return keymap.layer(() => layer)
    if (typeof keymap.registerLayer === "function") return keymap.registerLayer(layer)
  } catch (error) {
    logger.log({ event: "keymap-register-failed", error: error instanceof Error ? error.message : String(error) })
  }
  return undefined
}

/** Open the select dialog and apply the chosen action to the shared store. */
function openNativeNudgeDialog(api, store, now, logger) {
  try {
    const dialog = api?.ui?.dialog
    if (!dialog || typeof dialog.select !== "function") return
    dialog.select({
      title: NATIVE_NUDGE_DIALOG_TITLE,
      placeholder: "The same omo as one command, with no host app",
      options: NATIVE_NUDGE_OPTIONS.map((option) => ({ title: option.title, value: option.value })),
      onSelect: (option) => {
        try {
          const result = applyNativeEditionNudgeAction(option?.value, { store, now: now() })
          if (typeof dialog.clear === "function") dialog.clear()
          showToast(api, { message: result.toast })
        } catch (error) {
          logger.log({ event: "dialog-action-failed", error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  } catch (error) {
    logger.log({ event: "dialog-open-failed", error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Build the nudge CLI plugin surface. Tests drive `setup` with a fake context;
 * the default export wires `setup` for the host.
 */
export function createNudgeCliSurface(overrides = {}) {
  return {
    id: NUDGE_PLUGIN_ID,
    setup(context) {
      const config = resolveNativeNudgeConfig(context?.options ?? overrides.options)
      if (!config) return undefined

      const renderer = context?.renderer
      if (!renderer || renderer.isDestroyed === true) return undefined

      const logger = createLogger(resolveLogPath(overrides, context?.options))
      const now = typeof overrides.now === "function" ? overrides.now : () => Date.now()
      const store =
        overrides.store ??
        createNudgeStateStore(
          overrides.stateDir ?? resolveNudgeStateDir({ env: process.env, home: overrides.home ?? homedir() }),
        )
      const detect =
        typeof overrides.detectNativeEdition === "function"
          ? overrides.detectNativeEdition
          : () => detectNativeEdition({ existsSync, home: overrides.home ?? homedir() })
      const interactive =
        typeof overrides.interactive === "function"
          ? overrides.interactive
          : () => isInteractiveSession(process.env, process.stdout?.isTTY === true)
      const version = overrides.version ?? config.version ?? "unknown"
      const disposers = []
      let shownThisProcess = false

      const persist = (next) => {
        if (next === null || next === undefined) return true
        try {
          return typeof store?.write === "function" ? store.write(next) === true : false
        } catch (error) {
          logger.log({ event: "state-write-failed", error: error instanceof Error ? error.message : String(error) })
          return false
        }
      }

      const onSessionCreated = (event) => {
        try {
          const sessionID = extractSessionID(event)
          const session = sessionID ? readSession(context, sessionID) : undefined
          const childSession =
            session !== undefined && session !== null && session.parentID !== undefined && session.parentID !== null

          const decision = decideNativeEditionNudge({
            now: now(),
            state: typeof store?.read === "function" ? store.read() : "missing",
            nativeEditionInstalled: detect() === true,
            hookDisabled: false,
            interactive: interactive() === true,
            childSession,
            shownThisProcess,
            stateWritable: typeof store?.probeWritable === "function" ? store.probeWritable() === true : false,
            toastAvailable: typeof context?.ui?.toast?.show === "function" || typeof context?.ui?.toast === "function",
            version,
          })

          if (!decision.show) {
            persist(decision.nextState)
            return
          }

          // Claim the slot before showing. If the write fails the toast is
          // skipped entirely, because a nudge that cannot record itself would
          // reappear on every session start.
          if (!persist(decision.nextState)) {
            logger.log({ event: "nudge-suppressed", reason: "state-write-failed" })
            return
          }
          shownThisProcess = true
          showToast(context, {
            title: NATIVE_NUDGE_TOAST_TITLE,
            message: NATIVE_NUDGE_TOAST_MESSAGE,
            variant: "info",
            duration: NATIVE_NUDGE_TOAST_DURATION,
          })
          logger.log({ event: "nudge-toast", version })
        } catch (error) {
          logger.log({ event: "nudge-failed", error: error instanceof Error ? error.message : String(error) })
        }
      }

      const subscribe = (name, handler) => {
        if (typeof context?.data?.on !== "function") return
        try {
          const off = context.data.on(name, handler)
          if (typeof off === "function") disposers.push(off)
        } catch (error) {
          logger.log({ event: "subscribe-failed", name, error: error instanceof Error ? error.message : String(error) })
        }
      }

      subscribe("session.created", onSessionCreated)

      const layerDispose = registerNativeCommand(context, () => openNativeNudgeDialog(context, store, now, logger), logger)
      if (typeof layerDispose === "function") disposers.push(layerDispose)

      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch (error) {
            logger.log({ event: "dispose-failed", error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
    },
  }
}

export default createNudgeCliSurface()
