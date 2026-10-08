/**
 * Pure port of the V1 `session-stopped-on-error` error reader. The V1 counter was
 * a TEMPORAL poll (10 x 3s); the native V2 runtime is event-driven and a terminal
 * errored child emits ONE `session.execution.failed` event (the session then idles
 * with no plugin-visible idle edge), so the finalization decision rides that
 * terminal edge (see `handleChildFailure`) with no counter.
 *
 * The V2 transcript is a flat message list whose entries carry a top-level `type`
 * (`"assistant"`, `"user"`, `"idle"`, `"system"`, `"model-switched"`, ...), not the
 * V1 `{ info: { role } }` shape, and the host appends session-level markers (an
 * `idle` after every turn end, a `model-switched` after a fallback) that are NOT
 * turns. The reader therefore has to accept both shapes and walk back over the
 * non-turn markers to reach the turn the session actually stopped on.
 */

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function describeSessionError(error) {
  if (!isRecord(error)) return String(error)
  const data = isRecord(error.data) ? error.data : undefined
  const message = typeof data?.message === "string" ? data.message
    : typeof error.message === "string" ? error.message
      : undefined
  // V1 errors name themselves via `name`; the real V2 `Session.StructuredError`
  // names itself via `type`. Accept both so the described cause is never blank.
  const name = typeof error.name === "string" ? error.name
    : typeof error.type === "string" ? error.type
      : undefined
  return [name, message].filter((value) => Boolean(value)).join(": ") || "unknown error"
}

export { describeSessionError }

/** The turn role of a message, across the V2 flat shape and the V1 `info` shape. */
function messageRole(message) {
  if (!isRecord(message)) return undefined
  if (typeof message.type === "string") return message.type
  if (typeof message.role === "string") return message.role
  if (isRecord(message.info)) {
    if (typeof message.info.type === "string") return message.info.type
    if (typeof message.info.role === "string") return message.info.role
  }
  return undefined
}

/** The raw error carried by a message, from the message or its V1 `info`. */
function messageError(message) {
  if (!isRecord(message)) return undefined
  if (message.error !== undefined && message.error !== null) return message.error
  if (isRecord(message.info) && message.info.error !== undefined && message.info.error !== null) return message.info.error
  return undefined
}

// Session-level markers the V2 host appends around (not as) a turn. They must be
// skipped so the reader reaches the assistant turn the session stopped on.
const NON_TURN_TYPES = new Set(["idle", "system", "model-switched", "compaction"])

/**
 * Return the RAW error carried by the last assistant turn, or undefined. The
 * retry classifier needs the original structure (type/message/status/data), not a
 * formatted string, so this is the reader the manager injects. Trailing non-turn
 * markers (`idle`, `system`, `model-switched`, `compaction`) are skipped; a
 * non-assistant turn encountered first means the session did not stop on an
 * errored assistant turn.
 */
export function getStoppedSessionErrorInfo(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messageRole(messages[index])
    if (role === undefined || NON_TURN_TYPES.has(role)) continue
    if (role !== "assistant") return undefined
    const error = messageError(messages[index])
    return error === undefined ? undefined : error
  }
  return undefined
}

/**
 * Return the stopped-session error described as a string when the latest turn is
 * an errored assistant turn, else undefined. Accepts the V2 transcript shape
 * (flat `{ type, error }` plus host markers) and the V1 `{ info: { role, error } }`
 * shape.
 */
export function getStoppedSessionError(messages) {
  const error = getStoppedSessionErrorInfo(messages)
  return error === undefined ? undefined : describeSessionError(error)
}
