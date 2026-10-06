/**
 * Oh My Rigel session notifications, V2 companion CLI plugin.
 *
 * Export contract: this module is the package `./tui` entrypoint. OpenCode V2
 * validates a default export `{ id, setup(api) }` and calls `setup` with the
 * CLI plugin context (`ui.toast`, `attention`, `data`, `client`, `location`,
 * `options`, `renderer`, ...). Returning a function registers cleanup.
 *
 * Effect mapping, V1 `hooks/session-notification/` -> V2:
 *   session.idle            -> `data.on("session.idle")` with the V1 idle
 *                              confirmation delay and activity cancellation
 *   permission.*            -> `data.on("permission.asked")`
 *   question tool           -> `data.on("form.created")` (V2 input-needed form)
 *   OS notification         -> `context.attention.notify(...)`
 *   platform sound          -> `context.attention.notify({ sound })` resolved
 *                              to the platform sound pack by the host
 *   in-TUI notice           -> `context.ui.toast.show(...)`
 *   subagent skip           -> `data.session.get(sessionID).parentID` plus the
 *                              root-session check
 *
 * The plugin is inert unless its config is present and `enabled` is true: it
 * registers nothing and writes nothing, so an absent configuration is exactly
 * zero side effects. Every effect is contained and logged; a failure never
 * throws into the host.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import {
  buildIdleContent,
  createIdleScheduler,
  extractRequestID,
  extractRequestTitle,
  extractSessionID,
  isActivityEvent,
  isNotifiableSession,
  isPermissionHint,
  isPermissionEvent,
  isQuestionEvent,
  notificationSoundName,
  resolveNotificationConfig,
} from "./rigel-v2-native-notification-core.mjs"
import { readBackgroundMarker } from "./rigel-v2-background-marker.mjs"
import { readTodoPending, resolveBridgeStateRoot } from "./rigel-v2-native-todo-pending.mjs"
import { claimEmission, emissionGuardKey, releaseEmission } from "./rigel-v2-native-emission-guard.mjs"

export const NOTIFICATION_PLUGIN_ID = "oh-my-rigel.notification"

function resolveLogPath(options) {
  if (typeof options?.logFile === "string" && options.logFile.length > 0) return options.logFile
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "oh-my-rigel", "session-notification.log")
}

function createLogger(logPath) {
  let active = true
  return {
    log(entry) {
      if (!active) return
      try {
        mkdirSync(dirname(logPath), { recursive: true })
        appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8")
      } catch (error) {
        if (error instanceof Error) {
          active = false
        }
      }
    },
  }
}

function readSession(api, sessionID) {
  try {
    return api?.data?.session?.get?.(sessionID)
  } catch (error) {
    if (error instanceof Error) return undefined
    return undefined
  }
}

function readRootSessionID(api, sessionID) {
  try {
    const root = api?.data?.session?.root?.(sessionID)
    return typeof root === "string" && root.length > 0 ? root : undefined
  } catch (error) {
    if (error instanceof Error) return undefined
    return undefined
  }
}

function readSessionMessages(api, sessionID) {
  try {
    const messages = api?.data?.session?.message?.list?.(sessionID)
    return Array.isArray(messages) ? messages : []
  } catch (error) {
    if (error instanceof Error) return []
    return []
  }
}

/**
 * Build the plugin `setup` function. Exported separately so tests can drive it
 * with a fake context without importing the default export indirection.
 */
export function createNotificationPlugin(overrides = {}) {
  return {
    id: NOTIFICATION_PLUGIN_ID,
    setup(api) {
      const rawOptions = api?.options?.notification ?? api?.options
      const config = resolveNotificationConfig(rawOptions)
      // Absent or disabled config: register nothing, write nothing. This is the
      // "exactly zero side effects" contract.
      if (!config) return undefined

      const logger = createLogger(resolveLogPath({ ...api?.options, ...overrides }))
      logger.log({ event: "setup", enabled: true })

      const renderer = api?.renderer
      if (!renderer || renderer.isDestroyed === true) {
        logger.log({ event: "headless-skip" })
        return undefined
      }

      const directory = api?.location?.current?.directory ?? api?.location?.directory
      const stateRoot = overrides.stateRoot ?? resolveBridgeStateRoot(process.env)
      const disposers = []

      // V1 `hasPendingSessionWork`: a background-task continuation is active, or
      // the session still has incomplete todos. The background branch reads the
      // V1 marker file; the todo branch reads the per-session file the runtime's
      // todo store owner mirrors under the shared state root (the server store
      // is a different process and is not CLI-reachable).
      const hasPendingWork = async (sessionID) => {
        if (config.skipIfIncompleteTodos !== true) return false
        try {
          const session = readSession(api, sessionID)
          const sessionDirectory = session?.location?.directory ?? directory
          const background = readBackgroundMarker(sessionDirectory, sessionID)
          if (background?.state === "active") {
            logger.log({ event: "pending-work", reason: "background-task", sessionID })
            return true
          }
          const todos = readTodoPending({ stateRoot, sessionID })
          if (todos?.pending === true) {
            logger.log({ event: "pending-work", reason: "incomplete-todos", sessionID, incomplete: todos.incomplete, total: todos.total })
            return true
          }
          return false
        } catch (error) {
          logger.log({ event: "pending-work-probe-failed", sessionID, error: error instanceof Error ? error.message : String(error) })
          return false
        }
      }

      const emit = async (kind, sessionID, message, title, requestID) => {
        try {
          const session = readSession(api, sessionID)
          const isChild = session?.parentID !== undefined && session?.parentID !== null
          const rootSessionID = readRootSessionID(api, sessionID)
          if (!isNotifiableSession({ sessionID, rootSessionID, isChild, enforceMainSessionFilter: config.enforceMainSessionFilter })) {
            logger.log({
              event: "suppressed",
              reason: isChild ? "subagent" : "non-main-session",
              kind,
              sessionID,
              requestID: requestID ?? null,
            })
            return
          }

          const noticeTitle = title ?? session?.title ?? config.title
          const sound = config.playSound ? { name: notificationSoundName(config, kind), when: "always" } : undefined

          if (config.attentionEnabled !== false && typeof api?.attention?.notify === "function") {
            const result = await api.attention.notify({
              title: noticeTitle,
              message,
              notification: isChild ? false : { when: "blurred" },
              ...(sound ? { sound } : {}),
            })
            logger.log({
              event: "attention",
              kind,
              sessionID,
              requestID: requestID ?? null,
              ok: result?.ok ?? null,
              skipped: result?.skipped ?? null,
              sound: sound?.name ?? null,
            })
          }

          if (config.toastEnabled !== false && typeof api?.ui?.toast?.show === "function") {
            api.ui.toast.show({
              title: noticeTitle,
              message,
              variant: "info",
              duration: config.toastDuration,
              sessionID,
            })
            logger.log({ event: "toast", kind, sessionID, requestID: requestID ?? null, sessionTitle: session?.title ?? null })
          }
        } catch (error) {
          logger.log({
            event: "emit-failed",
            kind,
            sessionID,
            requestID: requestID ?? null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const scheduler = createIdleScheduler({
        config,
        ...(overrides.timer ? { now: overrides.timer.now, setTimer: overrides.timer.setTimer, clearTimer: overrides.timer.clearTimer } : {}),
        hasPendingWork,
        onLog: (entry) => logger.log({ ...entry, at: undefined }),
        emitIdle: async (sessionID) => {
          const session = readSession(api, sessionID)
          const content = buildIdleContent({
            baseTitle: config.title,
            baseMessage: config.message,
            sessionID,
            sessionTitle: session?.title,
            messages: readSessionMessages(api, sessionID),
          })
          await emit("idle", sessionID, content.message, content.title)
        },
      })

      const subscribe = (name, handler) => {
        if (typeof api?.data?.on !== "function") return
        const off = api.data.on(name, handler)
        if (typeof off === "function") disposers.push(off)
      }

      const seenRequests = new Set()

      // Idempotence for input-needed notices. The per-instance set covers a
      // re-delivery inside one instance; the file-backed shared guard covers a
      // duplicate that lands in another plugin instance (concurrent instances /
      // reconnects). Both are keyed by `${kind}:${sessionID}:${requestID}`.
      const claimRequest = (kind, sessionID, requestID) => {
        if (!requestID) return true
        const instanceKey = `${kind}:${sessionID}:${requestID}`
        if (seenRequests.has(instanceKey)) {
          logger.log({ event: "deduplicated", kind, sessionID, requestID, scope: "instance" })
          return false
        }
        if (!claimEmission({ stateRoot, key: emissionGuardKey(kind, sessionID, requestID) })) {
          seenRequests.add(instanceKey)
          logger.log({ event: "deduplicated", kind, sessionID, requestID, scope: "shared" })
          return false
        }
        seenRequests.add(instanceKey)
        return true
      }

      const releaseRequest = (kind, sessionID, requestID) => {
        if (!requestID) return
        const instanceKey = `${kind}:${sessionID}:${requestID}`
        seenRequests.delete(instanceKey)
        releaseEmission({ stateRoot, key: emissionGuardKey(kind, sessionID, requestID) })
      }

      // V1 notified on `session.idle` (turn end). The V2 CLI client is delivered
      // the execution lifecycle (`session.execution.succeeded`/`interrupted`),
      // which is the same "the agent finished and is ready for input" edge and
      // is what the host's own notifier uses. `session.idle` is kept in case the
      // client also receives it; the scheduler deduplicates either way.
      const scheduleCompletionNotice = (event) => {
        const sessionID = extractSessionID(event)
        if (sessionID) scheduler.scheduleIdle(sessionID)
      }
      subscribe("session.idle", scheduleCompletionNotice)
      subscribe("session.execution.succeeded", scheduleCompletionNotice)
      subscribe("session.execution.interrupted", scheduleCompletionNotice)

      subscribe("permission.asked", (event) => {
        if (!isPermissionEvent(event?.type ?? "permission.asked")) return
        const sessionID = extractSessionID(event)
        if (!sessionID) return
        scheduler.markActivity(sessionID)
        const requestID = extractRequestID(event)
        if (!claimRequest("permission", sessionID, requestID)) return
        void emit("permission", sessionID, config.permissionMessage, undefined, requestID)
      })

      subscribe("form.created", (event) => {
        if (!isQuestionEvent(event?.type ?? "form.created")) return
        const sessionID = extractSessionID(event)
        if (!sessionID) return
        scheduler.markActivity(sessionID)
        const requestID = extractRequestID(event)
        if (!claimRequest("question", sessionID, requestID)) return
        const requestTitle = extractRequestTitle(event)
        const message = isPermissionHint(requestTitle) ? config.permissionMessage : config.questionMessage
        void emit("question", sessionID, message, requestTitle, requestID)
      })

      subscribe("permission.replied", (event) => {
        const sessionID = extractSessionID(event)
        releaseRequest("permission", sessionID, extractRequestID(event))
      })

      subscribe("form.replied", (event) => {
        const sessionID = extractSessionID(event)
        releaseRequest("question", sessionID, extractRequestID(event))
      })

      subscribe("form.cancelled", (event) => {
        const sessionID = extractSessionID(event)
        releaseRequest("question", sessionID, extractRequestID(event))
      })

      subscribe("session.deleted", (event) => {
        const sessionID = extractSessionID(event)
        if (sessionID) scheduler.deleteSession(sessionID)
      })

      const allEvents = api?.data?.subscribe ?? api?.data?.listen
      if (typeof allEvents === "function") {
        const off = allEvents((event) => {
          // `data.on` delivers the event itself; `data.subscribe`/`listen`
          // deliver `{ name, details }` with the event under `details`.
          // Normalise before reading.
          const raw = event?.details ?? event
          const type = raw?.type
          if (!isActivityEvent(type)) return
          const sessionID = extractSessionID(raw)
          if (sessionID) scheduler.markActivity(sessionID)
        })
        if (typeof off === "function") disposers.push(off)
      }

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

export default createNotificationPlugin()
