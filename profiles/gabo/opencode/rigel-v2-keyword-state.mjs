/**
 * Pure keyword-detector state for Oh My Rigel's native OpenCode V2 runtime.
 *
 * Ports the two session stores owned by the V1 keyword-detector hook
 * (`packages/omo-opencode/src/hooks/keyword-detector/hook.ts`):
 *
 * 1. Default-mode injected sessions: a plain Set remembering which sessions
 *    already received the default-ultrawork toast/activation, capped at 256
 *    with FIFO eviction of the oldest insertion.
 * 2. Explicit ultrawork sessions: a Map of `{ source, needsRestoration }`.
 *    `session.compacted` marks the record for restoration; `session.deleted`
 *    and `clearSession` remove it. Also capped at 256, evicting the oldest
 *    insertion before a new key is added.
 *
 * Restoration guidance is the V1 `getSystemTransformGuidance` decision:
 * undefined unless the record needs restoration and the session is not a
 * planner agent, non-OMO agent, or subagent session; otherwise the recorded
 * source, or a source re-derived from the current agent/model when a modelID
 * is supplied. Message bodies are binding-owned: pass `messageForSource`.
 *
 * Pure module: imports only the sibling keyword core; no I/O, no timers.
 */

import {
  getUltraworkSource,
  isNonOmoAgent,
  isPlannerAgent,
} from "./rigel-v2-keyword-core.mjs"

export const KEYWORD_STATE_CAP = 256

function evictOldestIfFull(collection, cap) {
  if (collection.size >= cap) {
    const oldest = collection.keys().next().value
    if (oldest !== undefined) collection.delete(oldest)
  }
}

/**
 * @param {{ cap?: number, messageForSource?: (source: string) => string }} [options]
 */
export function createKeywordState({ cap = KEYWORD_STATE_CAP, messageForSource } = {}) {
  const defaultModeInjected = new Set()
  const explicitSessions = new Map()

  function hasDefaultModeInjected(sessionID) {
    return typeof sessionID === "string" && defaultModeInjected.has(sessionID)
  }

  function rememberDefaultModeInjected(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false
    if (defaultModeInjected.has(sessionID)) return false
    evictOldestIfFull(defaultModeInjected, cap)
    defaultModeInjected.add(sessionID)
    return true
  }

  function clearDefaultModeInjected(sessionID) {
    return defaultModeInjected.delete(sessionID)
  }

  function clearAllDefaultModeInjected() {
    defaultModeInjected.clear()
  }

  function getExplicit(sessionID) {
    const entry = explicitSessions.get(sessionID)
    return entry ? { ...entry } : undefined
  }

  /** V1 write: insert; evict the oldest insertion first only for a new key. */
  function rememberExplicit(sessionID, { source } = {}) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false
    if (!explicitSessions.has(sessionID)) evictOldestIfFull(explicitSessions, cap)
    explicitSessions.set(sessionID, { source, needsRestoration: false })
    return true
  }

  function markNeedsRestoration(sessionID) {
    const active = explicitSessions.get(sessionID)
    if (!active) return false
    explicitSessions.set(sessionID, { ...active, needsRestoration: true })
    return true
  }

  /** V1 hook `clearSession`: removes the explicit record only. */
  function clearSession(sessionID) {
    return explicitSessions.delete(sessionID)
  }

  function clearAll() {
    explicitSessions.clear()
    defaultModeInjected.clear()
  }

  /**
   * V1 event handling: `session.compacted` flags the record for restoration;
   * `session.deleted` clears both stores. Returns true when the event type was
   * recognized and a sessionID was present.
   */
  function handleEvent(event) {
    const type = event?.type
    const sessionID = typeof event?.sessionID === "string" && event.sessionID.length > 0
      ? event.sessionID
      : undefined
    if (!sessionID) return false
    if (type === "session.compacted") {
      markNeedsRestoration(sessionID)
      return true
    }
    if (type === "session.deleted") {
      clearSession(sessionID)
      clearDefaultModeInjected(sessionID)
      return true
    }
    return false
  }

  /** V1 `getSystemTransformGuidance` source decision (message body excluded). */
  function getRestorationSource(sessionID, { agent, modelID, isSubagentSession } = {}) {
    const active = explicitSessions.get(sessionID)
    if (!active?.needsRestoration) return undefined
    if (isPlannerAgent(agent) || isNonOmoAgent(agent) || isSubagentSession === true) return undefined
    if (modelID === undefined) return active.source
    return getUltraworkSource(agent, modelID)
  }

  /**
   * Restoration guidance for the system boundary. Returns undefined when V1
   * would return undefined; `{ source }` when no message resolver is available;
   * `{ source, message }` when `messageForSource` (per-call or construction
   * option) resolves the prompt body for that source.
   */
  function getRestoration(sessionID, options = {}) {
    const source = getRestorationSource(sessionID, options)
    if (source === undefined) return undefined
    const resolve = typeof options.messageForSource === "function"
      ? options.messageForSource
      : messageForSource
    if (typeof resolve !== "function") return { source }
    return { source, message: resolve(source) }
  }

  return {
    hasDefaultModeInjected,
    rememberDefaultModeInjected,
    clearDefaultModeInjected,
    clearAllDefaultModeInjected,
    getExplicit,
    rememberExplicit,
    markNeedsRestoration,
    clearSession,
    clearAll,
    handleEvent,
    getRestorationSource,
    getRestoration,
  }
}
