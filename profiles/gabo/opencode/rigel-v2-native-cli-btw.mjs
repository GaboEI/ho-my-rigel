/**
 * Oh My Rigel BTW side-conversation CLI surface, V2 companion plugin.
 *
 * Port of the V1 TUI owner `packages/omo-opencode/src/features/btw-side/`
 * (`tui-wiring.ts` + `tui-picker.ts` + `tui-keymap.ts` + `tui-session-bridge.ts`)
 * onto the V2 CLI plugin context (`{ renderer, ui, keymap, data, client,
 * location, options }`).
 *
 * Surfaces:
 *   - keymap command `/btw` (alias `side`) opening a `context.ui.dialog.select`
 *     picker of candidate parent sessions from `context.data.session.list()`;
 *   - selection either navigates to a retained session or starts a NEW side
 *     through the controller (which creates the V2 session with the
 *     `omo_btw_side` metadata via the real V2 session API);
 *   - double-escape return wired through `context.keymap.intercept("key", ...)`;
 *   - a `prompt.footer.status` slot reflecting the active side.
 *
 * V2 session API (verified against `rigel-v2-native-core.mjs` sessionApi):
 * `client.v2.session ?? client.session` with `.create({ agent, location,
 * parentID, model })` returning the created session (`data.id`). A CLI context
 * that only exposes the read-only `data.session` surface is routed through
 * `v2.session` / `session` / `client` and degrades to a logged toast when no
 * creator exists.
 *
 * A headless host (no renderer) is a safe no-op: `setup` returns undefined and
 * registers nothing. Every effect is contained and logged; a failure never
 * throws into the host.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  BTW_PICKER_NEW_PREFIX,
  BTW_PICKER_SESSION_PREFIX,
  buildBtwPickerOptions,
  candidateParentSessions,
  classifyBtwSessionCatalog,
  createBtwController,
  createBtwEscapeReturn,
  parseBtwPickerValue,
} from "./rigel-v2-btw-core.mjs"

export const BTW_CLI_PLUGIN_ID = "oh-my-rigel.btw"
export const BTW_COMMAND_ID = "omo.btw.slash"
export const BTW_COMMAND_SLASH_NAME = "btw"
export const BTW_COMMAND_ALIASES = Object.freeze(["side"])
export const BTW_FOOTER_SLOT_NAME = "prompt.footer.status"
export const BTW_DIALOG_TITLE = "BTW conversations"

function resolveLogPath(overrides, contextOptions) {
  if (typeof overrides?.logFile === "string" && overrides.logFile.length > 0) return overrides.logFile
  if (typeof contextOptions?.logFile === "string" && contextOptions.logFile.length > 0) return contextOptions.logFile
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "oh-my-rigel", "btw-cli.log")
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

function showToast(context, message, variant = "info") {
  try {
    const toast = context?.ui?.toast
    if (toast && typeof toast.show === "function") toast.show({ message, variant })
    else if (typeof toast === "function") toast({ message, variant })
  } catch {
    // toast is best-effort; never break the command on a UI failure
  }
}

function sessionIdFromEvent(raw) {
  const event = raw?.details ?? raw
  const id = event?.sessionID ?? event?.sessionId ?? event?.properties?.info?.id ?? event?.properties?.sessionID
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/** The V2 session creator surface, or undefined when the host has none. */
export function resolveBtwSessionApi(context) {
  const candidates = [context?.v2?.session, context?.session, context?.client?.v2?.session, context?.client?.session, context?.data?.session]
  for (const api of candidates) {
    if (api && typeof api.create === "function") return api
  }
  return undefined
}

/** Current session id across the known CLI context shapes. */
export function currentBtwSessionID(context) {
  try {
    const dataSession = context?.data?.session
    if (dataSession) {
      if (typeof dataSession.current === "function") {
        const id = dataSession.current()
        if (typeof id === "string" && id.length > 0) return id
      }
      if (typeof dataSession.current?.id === "string" && dataSession.current.id.length > 0) return dataSession.current.id
    }
    const location = context?.location?.current
    if (typeof location?.sessionID === "string" && location.sessionID.length > 0) return location.sessionID
    if (typeof context?.session?.current === "function") {
      const id = context.session.current()
      if (typeof id === "string" && id.length > 0) return id
    }
  } catch {
    return undefined
  }
  return undefined
}

function readSession(context, sessionID) {
  try {
    return context?.data?.session?.get?.(sessionID)
  } catch {
    return undefined
  }
}

function readMessages(context, sessionID) {
  try {
    const messages = context?.data?.session?.message?.list?.(sessionID)
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}

async function readSessionList(context) {
  const list = context?.data?.session?.list
  if (typeof list !== "function") return []
  const directory = context?.location?.current?.directory ?? context?.location?.directory
  try {
    const result = await list({ directory, roots: false, limit: 200 })
    return Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []
  } catch {
    try {
      const result = await list()
      return Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []
    } catch {
      return []
    }
  }
}

function navigateToSession(context, sessionID, logger) {
  const route = context?.route ?? context?.navigation
  try {
    if (route && typeof route.navigate === "function") return route.navigate("session", { sessionID })
    if (route && typeof route.go === "function") return route.go({ sessionID })
    if (typeof context?.navigate === "function") return context.navigate(sessionID)
  } catch (error) {
    logger.log({ event: "navigate-failed", sessionID, error: error instanceof Error ? error.message : String(error) })
  }
  logger.log({ event: "navigate-unavailable", sessionID })
  return undefined
}

/** Footer label for the controller's current phase. */
export function btwFooterLabel(state) {
  if (!state || typeof state !== "object") return ""
  if (state.phase === "creating") return "BTW starting..."
  if (state.phase === "closing") return "BTW closing..."
  if (state.phase === "open") return `BTW · ${state.sideSessionID} · esc esc return`
  return ""
}

/** Build picker options for a candidate-parent list (fallback when no catalog). */
export function buildCandidateParentOptions(candidates, currentSessionID) {
  const options = candidates.map((session) => ({
    title: `Main · ${String(session.title ?? "").trim() || "Untitled conversation"}`,
    value: `${BTW_PICKER_SESSION_PREFIX}${session.id}`,
    description: session.id,
    category: "Parent conversations",
  }))
  if (options.length === 0) {
    options.push({
      title: "No parent sessions available",
      value: "empty",
      description: "Open a session first",
      category: "Parent conversations",
      disabled: true,
    })
  }
  const current = options.some((option) => option.value === `${BTW_PICKER_SESSION_PREFIX}${currentSessionID}`)
    ? `${BTW_PICKER_SESSION_PREFIX}${currentSessionID}`
    : options[0]?.value
  return { options, current }
}

/** Register the `/btw` (alias `side`) keymap command. */
export function registerBtwCommand(context, run, logger) {
  const keymap = context?.keymap
  if (!keymap || typeof keymap !== "object") return undefined
  const layer = {
    commands: [
      {
        id: BTW_COMMAND_ID,
        title: "BTW side conversation",
        value: BTW_COMMAND_ID,
        description: "Start or switch retained side conversations without interrupting the main turn",
        category: "Session",
        enabled: true,
        slash: { name: BTW_COMMAND_SLASH_NAME, aliases: [...BTW_COMMAND_ALIASES] },
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
  logger.log({ event: "keymap-unavailable" })
  return undefined
}

/**
 * Register the `prompt.footer.status` slot. Tries the documented `set` shape
 * first, then the `ui.slot.register` shape; degrades to a logged no-op when the
 * host exposes neither. Returns `{ update, dispose }`.
 */
export function registerBtwFooterSlot(context, getLabel, logger) {
  const update = (label) => {
    try {
      const status = context?.prompt?.footer?.status
      if (status && typeof status.set === "function") status.set(label)
      else if (typeof status === "function") status(label)
    } catch (error) {
      logger.log({ event: "footer-set-failed", error: error instanceof Error ? error.message : String(error) })
    }
  }
  try {
    const slots = context?.ui?.slot ?? context?.ui?.slots
    if (slots && typeof slots.register === "function") {
      const dispose = slots.register({ id: BTW_FOOTER_SLOT_NAME, order: 950, render: () => getLabel() })
      return { update: () => {}, dispose: () => { if (typeof dispose === "function") dispose() } }
    }
    const status = context?.prompt?.footer?.status
    if (status && typeof status.set === "function") {
      return {
        update,
        dispose: () => {
          try {
            status.set(undefined)
          } catch {
            // best-effort clear
          }
        },
      }
    }
    if (typeof status === "function") return { update, dispose: () => update("") }
  } catch (error) {
    logger.log({ event: "footer-register-failed", error: error instanceof Error ? error.message : String(error) })
  }
  logger.log({ event: "footer-slot-unavailable" })
  return { update: () => {}, dispose: () => {} }
}

/** Wire double-escape return through the V2 keymap interceptor when present. */
function registerBtwEscapeReturn(context, escapeReturn, logger) {
  const keymap = context?.keymap
  try {
    if (keymap && typeof keymap.intercept === "function") {
      return keymap.intercept("key", (keyContext) => escapeReturn.handle(keyContext), { priority: Number.MAX_SAFE_INTEGER })
    }
  } catch (error) {
    logger.log({ event: "escape-register-failed", error: error instanceof Error ? error.message : String(error) })
  }
  logger.log({ event: "escape-api-unavailable" })
  return undefined
}

/**
 * Build the BTW CLI surface. Tests drive `setup` with a fake context and pass
 * seams through `overrides` (`getCurrentSessionID`, `promptRef`, `logFile`,
 * `sessionApi`).
 */
export function createBtwCliSurface(overrides = {}) {
  return {
    id: BTW_CLI_PLUGIN_ID,
    setup(context) {
      const renderer = context?.renderer
      if (!renderer || renderer.isDestroyed === true) return undefined

      const logger = createLogger(resolveLogPath(overrides, context?.options))
      logger.log({ event: "setup" })

      const sessionApi = overrides.sessionApi ?? resolveBtwSessionApi(context)
      const getCurrent =
        typeof overrides.getCurrentSessionID === "function" ? overrides.getCurrentSessionID : () => currentBtwSessionID(context)

      const closeDialog = () => {
        try {
          if (typeof context?.ui?.dialog?.clear === "function") context.ui.dialog.clear()
        } catch (error) {
          logger.log({ event: "dialog-clear-failed", error: error instanceof Error ? error.message : String(error) })
        }
      }

      const createSession = async (input) => {
        if (!sessionApi || typeof sessionApi.create !== "function") {
          throw new Error("OpenCode V2 session.create is unavailable for BTW")
        }
        const created = await sessionApi.create({
          title: input.title,
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          location: context?.location?.current ?? context?.location,
        })
        const data = created?.data ?? created
        const id = data?.id ?? data?.sessionID ?? data?.session?.id
        if (typeof id !== "string" || id.length === 0) throw new Error("OpenCode V2 did not return a side session ID")
        return { id, title: typeof data?.title === "string" ? data.title : input.title }
      }

      const abortSession = async (sessionID) => {
        const abort = sessionApi?.abort ?? sessionApi?.interrupt
        if (typeof abort === "function") await abort({ sessionID })
      }
      const deleteSession = async (sessionID) => {
        const remove = sessionApi?.delete ?? sessionApi?.remove
        if (typeof remove === "function") await remove({ sessionID })
      }

      const deps = {
        getCurrentSessionID: () => getCurrent(),
        getSession: (sessionID) => readSession(context, sessionID),
        getMessages: (sessionID) => readMessages(context, sessionID),
        createSession,
        navigateSession: (sessionID) => navigateToSession(context, sessionID, logger),
        abortSession,
        deleteSession,
        showToast: (message) => showToast(context, message),
        requestRender: () => {},
      }

      const controller = createBtwController(deps)
      const footer = registerBtwFooterSlot(context, () => btwFooterLabel(controller.state()), logger)
      const refreshFooter = () => footer.update(btwFooterLabel(controller.state()))
      deps.requestRender = () => {
        try {
          if (typeof renderer.requestRender === "function") renderer.requestRender()
        } catch (error) {
          logger.log({ event: "render-failed", error: error instanceof Error ? error.message : String(error) })
        }
        refreshFooter()
      }
      refreshFooter()

      const handleSelection = async (value) => {
        const selection = parseBtwPickerValue(value)
        if (!selection) return
        if (selection.type === "new") {
          const promptRef =
            typeof overrides.promptRef === "function"
              ? overrides.promptRef()
              : { hasAttachments: false, input: "", set() {}, submit() {} }
          const started = await controller.startFromPrompt(promptRef, selection.parentSessionID)
          if (started) closeDialog()
          return
        }
        closeDialog()
        navigateToSession(context, selection.sessionID, logger)
      }

      const openPicker = async () => {
        const current = getCurrent()
        if (!current) {
          showToast(context, "BTW is unavailable before the session starts.", "warning")
          return false
        }
        const sessions = await readSessionList(context)
        const catalog = classifyBtwSessionCatalog(sessions, current)
        let picker
        if (catalog) {
          for (const [index, side] of catalog.sides.entries()) controller.adopt(catalog.main.id, side.id, index + 1)
          picker = buildBtwPickerOptions(catalog, current)
        } else {
          picker = buildCandidateParentOptions(candidateParentSessions(sessions), current)
        }
        const dialog = context?.ui?.dialog
        if (!dialog || typeof dialog.select !== "function") {
          logger.log({ event: "dialog-unavailable" })
          showToast(context, "Unable to open BTW conversations.", "warning")
          return false
        }
        dialog.select({
          title: BTW_DIALOG_TITLE,
          placeholder: "Choose a parent conversation to start a side from",
          options: picker.options,
          current: picker.current,
          onSelect: (option) => {
            const pending = handleSelection(option?.value)
            pending.catch((error) =>
              logger.log({ event: "selection-failed", error: error instanceof Error ? error.message : String(error) }),
            )
            return pending
          },
        })
        return true
      }

      const runBtw = () => {
        const pending = openPicker()
        pending.catch((error) => {
          logger.log({ event: "picker-failed", error: error instanceof Error ? error.message : String(error) })
          showToast(context, "Unable to open BTW conversations.", "error")
        })
        return pending
      }

      const escapeReturn = createBtwEscapeReturn({
        isCurrentSideIdle: () => {
          const state = controller.state()
          return state.phase === "open" && getCurrent() === state.sideSessionID
        },
        isDialogOpen: () => context?.ui?.dialog?.open === true,
        clearPending: () => {
          try {
            context?.keymap?.clearPendingSequence?.()
          } catch {
            // keymap may not expose pending-sequence clearing
          }
        },
        returnToParent: () => controller.returnToParent(),
      })

      const disposers = []
      const layerDispose = registerBtwCommand(context, runBtw, logger)
      if (typeof layerDispose === "function") disposers.push(layerDispose)
      const escapeDispose = registerBtwEscapeReturn(context, escapeReturn, logger)
      if (typeof escapeDispose === "function") disposers.push(escapeDispose)

      const subscribe = (name, handler) => {
        if (typeof context?.data?.on !== "function") return
        try {
          const off = context.data.on(name, handler)
          if (typeof off === "function") disposers.push(off)
        } catch (error) {
          logger.log({ event: "subscribe-failed", name, error: error instanceof Error ? error.message : String(error) })
        }
      }
      subscribe("session.deleted", (raw) => {
        const sessionID = sessionIdFromEvent(raw)
        if (sessionID) {
          controller.handleSessionDeleted(sessionID)
          refreshFooter()
        }
      })

      disposers.push(() => footer.dispose())

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

export default createBtwCliSurface()
