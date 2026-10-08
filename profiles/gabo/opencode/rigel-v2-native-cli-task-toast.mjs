/**
 * Oh My Rigel task-progress toasts, V2 companion CLI plugin.
 *
 * Export contract: the package's companion CLI entrypoint validates a default
 * export `{ id, setup(context) }` and calls `setup` with the CLI plugin context
 * (`ui.toast`, `data`, `renderer`, `location`, `options`, ...). Returning a
 * function registers cleanup.
 *
 * Effect mapping, V1 `features/task-toast-manager/` -> V2:
 *   addTask / updateTask              -> `session.execution.started` (and
 *                                        `session.created` for a queued child)
 *   showCompletionToast               -> `session.execution.succeeded`
 *   updateTask("error") + removeTask  -> `session.execution.failed`
 *   removeTask                        -> `session.deleted`
 *   durable background tasks[]        -> `rigel-v2-background-state.mjs`
 *   background-active marker          -> `rigel-v2-background-marker.mjs`
 *   `client.tui.showToast`            -> `context.ui.toast.show`
 *
 * The V1 `TaskToastManager` is ported pure and renderer-free in
 * `rigel-v2-native-task-toast-core.mjs`; this module is only the adapter that
 * translates V2 session events and the durable background state into manager
 * calls. It is inert unless its config is present and `enabled` is true, and it
 * skips entirely without a live renderer, so an absent configuration or a
 * headless host is exactly zero side effects. Every effect is contained and
 * logged; a failure never throws into the host.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import {
  createTaskToastManager,
  formatDuration,
} from "./rigel-v2-native-task-toast-core.mjs"
import { extractSessionID } from "./rigel-v2-native-notification-core.mjs"
import { readBackgroundMarker } from "./rigel-v2-background-marker.mjs"
import { readBackgroundState } from "./rigel-v2-background-state.mjs"

export const TASK_TOAST_CLI_ID = "oh-my-rigel.task-toast"

/** V1 background-agent default per-key concurrency (5). */
export const TASK_TOAST_DEFAULTS = Object.freeze({
  enabled: false,
  concurrencyLimit: 5,
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function positiveInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value)
  return fallback
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * Resolve the effective task-toast configuration. The V1 manager was created
 * unconditionally, so this surface is default-on once the companion CLI plugin
 * is loaded; only an explicit `enabled: false` disables it (then the caller
 * registers nothing and produces exactly zero side effects).
 */
export function resolveTaskToastConfig(raw) {
  if (isPlainObject(raw) && raw.enabled === false) return null
  const concurrencyLimit = isPlainObject(raw)
    ? positiveInteger(raw.concurrencyLimit, TASK_TOAST_DEFAULTS.concurrencyLimit)
    : TASK_TOAST_DEFAULTS.concurrencyLimit
  return Object.freeze({ enabled: true, concurrencyLimit })
}

function resolveLogPath(options) {
  if (typeof options?.logFile === "string" && options.logFile.length > 0) return options.logFile
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "oh-my-rigel", "task-toast.log")
}

function createLogger(logPath) {
  let active = true
  return (entry) => {
    if (!active) return
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8")
    } catch (error) {
      if (error instanceof Error) active = false
    }
  }
}

function readSession(context, sessionID) {
  try {
    return context?.data?.session?.get?.(sessionID)
  } catch (error) {
    if (error instanceof Error) return undefined
    return undefined
  }
}

function readParentID(session, raw) {
  const data = isPlainObject(raw?.data) ? raw.data : undefined
  return firstString(session?.parentID, session?.parentId, data?.parentID, data?.parentId, raw?.parentID)
}

/** Find the durable background descriptor for a child session, if any. */
function findBackgroundTask(directory, parentID, sessionID) {
  if (typeof parentID !== "string" || parentID.length === 0) return undefined
  const state = readBackgroundState(directory, parentID)
  if (!state || !Array.isArray(state.tasks)) return undefined
  return state.tasks.find(
    (task) => isPlainObject(task) && (task.sessionID === sessionID || task.id === sessionID || task.taskId === sessionID),
  )
}

/** Build the description / agent / category / model identity for a task. */
function buildIdentity(raw, session, sessionID, descriptor) {
  const data = isPlainObject(raw?.data) ? raw.data : raw
  const model = firstString(data?.model, session?.model, descriptor?.model)
  return {
    description: firstString(
      descriptor?.description,
      descriptor?.route,
      data?.description,
      data?.title,
      session?.title,
      descriptor?.agent,
      sessionID,
    ),
    agent: firstString(descriptor?.agent, descriptor?.subagentType, data?.agent, session?.agent, "task"),
    category: firstString(descriptor?.category, data?.category, session?.category),
    modelInfo: model ? { model, type: firstString(data?.modelType, "user-defined") } : undefined,
  }
}

/**
 * Build the CLI surface. Exported separately so tests can drive `setup` with a
 * fake context without importing the default export indirection.
 */
export function createTaskToastCliSurface(overrides = {}) {
  return {
    id: TASK_TOAST_CLI_ID,
    setup(context) {
      const rawOptions = context?.options?.task_toast ?? context?.options
      const config = resolveTaskToastConfig(rawOptions)
      if (!config) return undefined

      const logger = typeof overrides.log === "function"
        ? overrides.log
        : createLogger(resolveLogPath({ ...context?.options, ...overrides }))
      logger({ event: "setup", enabled: true, concurrencyLimit: config.concurrencyLimit })

      const renderer = context?.renderer
      if (!renderer || renderer.isDestroyed === true) {
        logger({ event: "headless-skip" })
        return undefined
      }

      const directory = context?.location?.current?.directory ?? context?.location?.directory
      const nowFn = typeof overrides.now === "function" ? overrides.now : () => Date.now()
      const disposers = []
      const tracked = new Map()

      const emitToast = (toast) => {
        try {
          if (typeof context?.ui?.toast?.show !== "function") {
            logger({ event: "toast-skip", reason: "no-renderer" })
            return
          }
          context.ui.toast.show(toast)
          logger({ event: "toast", title: toast?.title ?? null, variant: toast?.variant ?? null })
        } catch (error) {
          logger({ event: "toast-failed", error: error instanceof Error ? error.message : String(error) })
        }
      }

      const manager = createTaskToastManager({
        showToast: emitToast,
        getConcurrencyLimit: () => config.concurrencyLimit,
        now: nowFn,
      })

      const subscribe = (name, handler) => {
        if (typeof context?.data?.on !== "function") return
        try {
          const off = context.data.on(name, handler)
          if (typeof off === "function") disposers.push(off)
        } catch (error) {
          logger({ event: "subscribe-failed", name, error: error instanceof Error ? error.message : String(error) })
        }
      }

      const safe = (name, handler) => (raw) => {
        try {
          handler(raw)
        } catch (error) {
          logger({ event: "handler-failed", name, error: error instanceof Error ? error.message : String(error) })
        }
      }

      // A `session.created` marks a delegated child (parent-bearing session) as
      // a tracked task; its status comes from the durable background
      // descriptor, defaulting to running. Re-delivery is idempotent.
      subscribe("session.created", safe("session.created", (raw) => {
        const sessionID = extractSessionID(raw)
        if (!sessionID || tracked.has(sessionID)) return
        const session = readSession(context, sessionID)
        const parentID = readParentID(session, raw)
        if (!parentID) return
        const descriptor = findBackgroundTask(directory, parentID, sessionID)
        const identity = buildIdentity(raw, session, sessionID, descriptor)
        const status = descriptor?.status === "queued" ? "queued" : "running"
        manager.addTask({
          id: sessionID,
          sessionID,
          description: identity.description,
          agent: identity.agent,
          isBackground: true,
          status,
          category: identity.category,
          modelInfo: identity.modelInfo,
        })
        tracked.set(sessionID, {
          startedAt: nowFn(),
          isBackground: true,
          description: identity.description,
          agent: identity.agent,
          category: identity.category,
          modelInfo: identity.modelInfo,
        })
      }))

      subscribe("session.execution.started", safe("session.execution.started", (raw) => {
        const sessionID = extractSessionID(raw)
        if (!sessionID) return
        const session = readSession(context, sessionID)
        const parentID = readParentID(session, raw)
        const descriptor = findBackgroundTask(directory, parentID, sessionID)
        const isBackground = Boolean(descriptor) || readBackgroundMarker(directory, sessionID)?.state === "active"
        const identity = buildIdentity(raw, session, sessionID, descriptor)
        if (tracked.has(sessionID)) {
          manager.updateTask(sessionID, "running")
          if (identity.modelInfo) manager.updateTaskModelBySession(sessionID, identity.modelInfo)
          const record = tracked.get(sessionID)
          record.isBackground = isBackground
          return
        }
        manager.addTask({
          id: sessionID,
          sessionID,
          description: identity.description,
          agent: identity.agent,
          isBackground,
          status: "running",
          category: identity.category,
          modelInfo: identity.modelInfo,
        })
        tracked.set(sessionID, {
          startedAt: nowFn(),
          isBackground,
          description: identity.description,
          agent: identity.agent,
          category: identity.category,
          modelInfo: identity.modelInfo,
        })
      }))

      subscribe("session.execution.succeeded", safe("session.execution.succeeded", (raw) => {
        const sessionID = extractSessionID(raw)
        if (!sessionID) return
        const record = tracked.get(sessionID)
        const session = readSession(context, sessionID)
        const identity = buildIdentity(raw, session, sessionID, undefined)
        const description = record?.description ?? identity.description
        const duration = formatDuration(record?.startedAt ?? nowFn(), nowFn())
        manager.showCompletionToast({ id: sessionID, description, duration })
        tracked.delete(sessionID)
      }))

      subscribe("session.execution.failed", safe("session.execution.failed", (raw) => {
        const sessionID = extractSessionID(raw)
        if (!sessionID) return
        manager.updateTask(sessionID, "error")
        manager.removeTask(sessionID)
        tracked.delete(sessionID)
      }))

      subscribe("session.deleted", safe("session.deleted", (raw) => {
        const sessionID = extractSessionID(raw)
        if (!sessionID) return
        manager.removeTask(sessionID)
        tracked.delete(sessionID)
      }))

      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch (error) {
            logger({ event: "dispose-failed", error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
    },
  }
}

export default createTaskToastCliSurface()
