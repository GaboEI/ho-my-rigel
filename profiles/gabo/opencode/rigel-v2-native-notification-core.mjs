/**
 * Pure core for Oh My Rigel's native OpenCode V2 session notifications.
 *
 * V1 `hooks/session-notification/` notified the user outside of the model
 * context: an idle turn finished ("Agent is ready for input"), a permission was
 * requested, or a `question` tool awaited an answer. It gated on the main
 * session (never a subagent turn), a configurable hook switch, an external
 * notifier conflict, a minimum completion delay with activity cancellation,
 * a pending-work probe and per-session deduplication, and it played a
 * platform sound when configured.
 *
 * V2 exposes the effect through the companion CLI plugin surface
 * (`@opencode/plugin/tui`): `context.attention.notify(...)` for the system
 * notification plus sound, and `context.ui.toast.show(...)` for the in-TUI
 * notice. This module owns everything that does not touch that surface:
 * configuration resolution, event classification, notification content,
 * gating and the idle scheduler. It is dependency-free and deterministic so
 * every branch is unit-testable without a renderer.
 *
 * V1 sources ported here:
 *   packages/omo-opencode/src/hooks/session-notification.ts
 *   packages/omo-opencode/src/hooks/session-notification-scheduler.ts
 *   packages/omo-opencode/src/hooks/session-notification-content.ts
 *   packages/omo-opencode/src/hooks/session-notification-event-properties.ts
 */

/** V1 defaults, from `createSessionNotification`'s merged config. */
export const NOTIFICATION_DEFAULTS = Object.freeze({
  enabled: false,
  title: "OpenCode",
  message: "Agent is ready for input",
  questionMessage: "Agent is asking a question",
  permissionMessage: "Agent needs permission to continue",
  playSound: false,
  soundName: "done",
  idleConfirmationDelay: 1500,
  skipIfIncompleteTodos: true,
  maxTrackedSessions: 100,
  enforceMainSessionFilter: true,
  activityGracePeriodMs: 100,
  attentionEnabled: true,
  toastEnabled: true,
  toastDuration: 5000,
})

/** V1 `QUESTION_TOOLS` question-tool names. */
export const QUESTION_TOOLS = Object.freeze(["question", "ask_user_question", "askuserquestion"])

/** V1 `PERMISSION_HINT_PATTERN`: a question that is really a permission ask. */
export const PERMISSION_HINT_PATTERN = /\b(permission|approve|approval|allow|deny|consent)\b/i

/**
 * V2 events that mean "the session produced activity", used to cancel a pending
 * idle notification. Ported from V1's activity list (`session.created`,
 * `message.*`, `tool.execute.*`); `session.execution.started` is the V2
 * equivalent of a new run. `session.updated` is deliberately NOT activity: the
 * host emits it after a run completes (title/usage), and treating it as
 * activity would cancel the completion notice the plugin just scheduled.
 */
export const ACTIVITY_EVENT_TYPES = Object.freeze([
  "session.created",
  "session.execution.started",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.removed",
  "tool.execute.before",
  "tool.execute.after",
])

/** V2 input-needed surfaces that map V1's `permission.*` and `question` tool. */
export const PERMISSION_EVENT_TYPES = Object.freeze(["permission.asked"])
export const QUESTION_EVENT_TYPES = Object.freeze(["form.created"])

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function positiveInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value)
  return fallback
}

function nonNegativeInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value)
  return fallback
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function booleanOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback
}

/**
 * Resolve the effective notification configuration.
 *
 * Returns `null` when the feature is not configured or explicitly disabled:
 * the caller must then register nothing and produce exactly zero side effects
 * (V1: the hook is not created at all when `session-notification` is disabled
 * or an external notifier wins without `force_enable`).
 */
export function resolveNotificationConfig(raw) {
  if (!isPlainObject(raw)) return null
  if (raw.enabled !== true) return null
  return Object.freeze({
    enabled: true,
    title: stringOr(raw.title, NOTIFICATION_DEFAULTS.title),
    message: stringOr(raw.message, NOTIFICATION_DEFAULTS.message),
    questionMessage: stringOr(raw.questionMessage, NOTIFICATION_DEFAULTS.questionMessage),
    permissionMessage: stringOr(raw.permissionMessage, NOTIFICATION_DEFAULTS.permissionMessage),
    playSound: booleanOr(raw.playSound, NOTIFICATION_DEFAULTS.playSound),
    soundName: stringOr(raw.soundName, NOTIFICATION_DEFAULTS.soundName),
    idleConfirmationDelay: positiveInteger(raw.idleConfirmationDelay, NOTIFICATION_DEFAULTS.idleConfirmationDelay),
    skipIfIncompleteTodos: booleanOr(raw.skipIfIncompleteTodos, NOTIFICATION_DEFAULTS.skipIfIncompleteTodos),
    maxTrackedSessions: positiveInteger(raw.maxTrackedSessions, NOTIFICATION_DEFAULTS.maxTrackedSessions),
    enforceMainSessionFilter: booleanOr(raw.enforceMainSessionFilter, NOTIFICATION_DEFAULTS.enforceMainSessionFilter),
    activityGracePeriodMs: nonNegativeInteger(raw.activityGracePeriodMs, NOTIFICATION_DEFAULTS.activityGracePeriodMs),
    attentionEnabled: booleanOr(raw.attentionEnabled, NOTIFICATION_DEFAULTS.attentionEnabled),
    toastEnabled: booleanOr(raw.toastEnabled, NOTIFICATION_DEFAULTS.toastEnabled),
    toastDuration: positiveInteger(raw.toastDuration, NOTIFICATION_DEFAULTS.toastDuration),
  })
}

/**
 * Extract a session id from an event payload, mirroring V1
 * `getSessionID`/`resolveSessionEventID` tolerantly (V2 events carry the id
 * under `data.sessionID`, older shapes under `sessionID`/`sessionId`, forms
 * under `data.form.sessionID`).
 */
export function extractSessionID(properties) {
  const record = isPlainObject(properties) ? properties : undefined
  if (!record) return undefined
  for (const key of ["sessionID", "sessionId"]) {
    if (typeof record[key] === "string" && record[key].length > 0) return record[key]
  }
  const data = isPlainObject(record.data) ? record.data : undefined
  if (data) {
    for (const key of ["sessionID", "sessionId"]) {
      if (typeof data[key] === "string" && data[key].length > 0) return data[key]
    }
    const form = isPlainObject(data.form) ? data.form : undefined
    if (form && typeof form.sessionID === "string" && form.sessionID.length > 0) return form.sessionID
  }
  const form = isPlainObject(record.form) ? record.form : undefined
  if (form && typeof form.sessionID === "string" && form.sessionID.length > 0) return form.sessionID
  const info = isPlainObject(record.info) ? record.info : undefined
  if (info && typeof info.sessionID === "string" && info.sessionID.length > 0) return info.sessionID
  return undefined
}

/**
 * Extract the stable identifier of an input-needed request, used for
 * deduplication: a permission request id, or a form id.
 */
export function extractRequestID(properties) {
  const record = isPlainObject(properties) ? properties : undefined
  if (!record) return undefined
  const data = isPlainObject(record.data) ? record.data : record
  const form = isPlainObject(data.form) ? data.form : undefined
  if (form && typeof form.id === "string" && form.id.length > 0) return form.id
  if (typeof data.id === "string" && data.id.length > 0) return data.id
  if (typeof data.requestID === "string" && data.requestID.length > 0) return data.requestID
  return undefined
}

/** Human title of an input-needed request when the surface provides one. */
export function extractRequestTitle(properties) {
  const record = isPlainObject(properties) ? properties : undefined
  const data = isPlainObject(record?.data) ? record.data : undefined
  const form = isPlainObject(data?.form) ? data.form : undefined
  return typeof form?.title === "string" && form.title.length > 0 ? form.title : undefined
}

/** V1 `isPermissionHint`: a question that talks about permission. */
export function isPermissionHint(text) {
  return typeof text === "string" && PERMISSION_HINT_PATTERN.test(text)
}

/**
 * Sound name for a notification kind, resolved by the V2 attention surface to
 * the platform's sound pack (V1 selected a platform sound file directly).
 */
export function notificationSoundName(config, kind) {
  if (kind === "idle") return config?.soundName || "done"
  if (kind === "permission") return "permission"
  if (kind === "question") return "question"
  return "done"
}

export function isActivityEvent(eventType) {
  return typeof eventType === "string" && ACTIVITY_EVENT_TYPES.includes(eventType)
}

export function isPermissionEvent(eventType) {
  return typeof eventType === "string" && PERMISSION_EVENT_TYPES.includes(eventType)
}

export function isQuestionEvent(eventType) {
  return typeof eventType === "string" && QUESTION_EVENT_TYPES.includes(eventType)
}

/** V1 `collapseWhitespace`. */
export function collapseWhitespace(text) {
  if (typeof text !== "string") return ""
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
}

/** V1 `getLastNonEmptyLine`. */
export function getLastNonEmptyLine(text) {
  if (typeof text !== "string") return ""
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1] : ""
}

/**
 * Extract the visible text of a V2 message. V2 user/system messages carry a
 * `text` field; assistant messages carry `content` parts with a `text` type.
 * Tolerant by design so a shapeshifted host never throws inside a hook.
 */
export function extractMessageText(message) {
  if (!isPlainObject(message)) return ""
  if (typeof message.text === "string") return message.text
  const content = Array.isArray(message.content) ? message.content : undefined
  if (!content) return ""
  return content
    .filter((part) => isPlainObject(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
}

export function messageRole(message) {
  if (!isPlainObject(message)) return undefined
  if (typeof message.type === "string") return message.type
  const info = isPlainObject(message.info) ? message.info : undefined
  return typeof info?.role === "string" ? info.role : undefined
}

function findLastMessage(messages, role) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (messageRole(message) !== role) continue
    if (role === "assistant" && isPlainObject(message) && message.error) continue
    if (!extractMessageText(message)) continue
    return message
  }
  return undefined
}

/**
 * V1 `buildReadyNotificationContent`: the idle notice carries the session title
 * and the last user text plus last assistant line.
 */
export function buildIdleContent(input) {
  const baseTitle = stringOr(input?.baseTitle, NOTIFICATION_DEFAULTS.title)
  const baseMessage = stringOr(input?.baseMessage, NOTIFICATION_DEFAULTS.message)
  const sessionTitle = stringOr(input?.sessionTitle, input?.sessionID ?? "")
  const messages = Array.isArray(input?.messages) ? input.messages : []

  const lastUserText = collapseWhitespace(extractMessageText(findLastMessage(messages, "user")))
  const lastAssistantLine = getLastNonEmptyLine(extractMessageText(findLastMessage(messages, "assistant")))
  const detailLines = [
    lastUserText ? `User: ${lastUserText}` : "",
    lastAssistantLine ? `Assistant: ${lastAssistantLine}` : "",
  ].filter(Boolean)

  return {
    title: sessionTitle ? `${baseTitle} · ${sessionTitle}` : baseTitle,
    message: detailLines.length > 0 ? [baseMessage, ...detailLines].join("\n") : baseMessage,
  }
}

/**
 * V1 gate: a subagent (child) session must never notify, and with the main
 * session filter on, only the root session qualifies.
 */
export function isNotifiableSession({ sessionID, rootSessionID, isChild, enforceMainSessionFilter }) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return false
  if (isChild === true) return false
  if (enforceMainSessionFilter !== false) {
    if (typeof rootSessionID === "string" && rootSessionID.length > 0 && sessionID !== rootSessionID) return false
  }
  return true
}

/**
 * Port of V1 `createIdleNotificationScheduler`. Behavioural contract kept
 * exact: an idle event arms a timer; any activity inside the grace window
 * cancels it; a later idle re-arms; a session notified once is not notified
 * again until new activity; the pending-work probe can suppress the notice;
 * and a session deleted mid-flight is fully forgotten.
 *
 * All time and timer primitives are injectable so tests are deterministic.
 */
export function createIdleScheduler(options) {
  const config = options.config
  const now = typeof options.now === "function" ? options.now : Date.now
  const setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout
  const hasPendingWork = typeof options.hasPendingWork === "function" ? options.hasPendingWork : async () => false
  const emitIdle = typeof options.emitIdle === "function" ? options.emitIdle : async () => {}
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {}

  const notifiedSessions = new Set()
  const pendingTimers = new Map()
  const sessionActivitySinceIdle = new Set()
  const notificationVersions = new Map()
  const executingNotifications = new Set()
  const scheduledAt = new Map()

  const activityGracePeriodMs = config.activityGracePeriodMs

  function cleanupOldSessions() {
    const maxSessions = config.maxTrackedSessions
    const trim = (collection, isMap) => {
      if (collection.size <= maxSessions) return
      const keys = isMap ? Array.from(collection.keys()) : Array.from(collection)
      keys.slice(0, collection.size - maxSessions).forEach((key) => collection.delete(key))
    }
    trim(notifiedSessions, false)
    trim(sessionActivitySinceIdle, false)
    trim(notificationVersions, true)
    trim(executingNotifications, false)
    trim(scheduledAt, true)
  }

  function cancelPendingNotification(sessionID) {
    const timer = pendingTimers.get(sessionID)
    if (timer !== undefined) {
      clearTimer(timer)
      pendingTimers.delete(sessionID)
    }
    scheduledAt.delete(sessionID)
    sessionActivitySinceIdle.add(sessionID)
    notificationVersions.set(sessionID, (notificationVersions.get(sessionID) ?? 0) + 1)
  }

  function markActivity(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    const scheduledTime = scheduledAt.get(sessionID)
    if (activityGracePeriodMs > 0 && scheduledTime !== undefined && now() - scheduledTime <= activityGracePeriodMs) {
      return
    }
    cancelPendingNotification(sessionID)
    if (!executingNotifications.has(sessionID)) notifiedSessions.delete(sessionID)
  }

  async function executeNotification(sessionID, version) {
    if (executingNotifications.has(sessionID)) {
      pendingTimers.delete(sessionID)
      scheduledAt.delete(sessionID)
      return
    }
    if (notificationVersions.get(sessionID) !== version) {
      pendingTimers.delete(sessionID)
      scheduledAt.delete(sessionID)
      return
    }
    if (sessionActivitySinceIdle.has(sessionID)) {
      sessionActivitySinceIdle.delete(sessionID)
      pendingTimers.delete(sessionID)
      scheduledAt.delete(sessionID)
      return
    }
    if (notifiedSessions.has(sessionID)) {
      pendingTimers.delete(sessionID)
      scheduledAt.delete(sessionID)
      return
    }

    executingNotifications.add(sessionID)
    try {
      if (config.skipIfIncompleteTodos) {
        const pending = await hasPendingWork(sessionID)
        if (notificationVersions.get(sessionID) !== version) return
        if (pending === true) {
          onLog({ event: "idle-skipped", reason: "pending-work", sessionID })
          return
        }
      }
      if (notificationVersions.get(sessionID) !== version) return
      if (sessionActivitySinceIdle.has(sessionID)) {
        sessionActivitySinceIdle.delete(sessionID)
        return
      }

      notifiedSessions.add(sessionID)
      await emitIdle(sessionID)
    } finally {
      executingNotifications.delete(sessionID)
      pendingTimers.delete(sessionID)
      scheduledAt.delete(sessionID)
      if (sessionActivitySinceIdle.has(sessionID)) {
        notifiedSessions.delete(sessionID)
        sessionActivitySinceIdle.delete(sessionID)
      }
    }
  }

  function scheduleIdle(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (notifiedSessions.has(sessionID)) return
    if (pendingTimers.has(sessionID)) return
    if (executingNotifications.has(sessionID)) return

    sessionActivitySinceIdle.delete(sessionID)
    scheduledAt.set(sessionID, now())
    const currentVersion = (notificationVersions.get(sessionID) ?? 0) + 1
    notificationVersions.set(sessionID, currentVersion)
    const timer = setTimer(() => {
      void executeNotification(sessionID, currentVersion)
    }, config.idleConfirmationDelay)
    pendingTimers.set(sessionID, timer)
    cleanupOldSessions()
  }

  function deleteSession(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    cancelPendingNotification(sessionID)
    notifiedSessions.delete(sessionID)
    sessionActivitySinceIdle.delete(sessionID)
    notificationVersions.delete(sessionID)
    executingNotifications.delete(sessionID)
    scheduledAt.delete(sessionID)
  }

  return { markActivity, scheduleIdle, deleteSession }
}
