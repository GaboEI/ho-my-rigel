const TOKEN_LIMIT_PATTERN = /(?:prompt is too long|context length|token limit|maximum context)/i

function eventSessionID(event) {
  const sessionID = event?.sessionID ?? event?.data?.sessionID ?? event?.data?.session?.id ?? event?.properties?.sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}

function eventMessage(event) {
  const value = event?.error?.message ?? event?.data?.error?.message ?? event?.properties?.error?.message ?? event?.properties?.message
  return typeof value === "string" ? value : ""
}

/**
 * V2 emits `session.idle` / `session.status`, and a completed turn surfaces as
 * `session.execution.succeeded`. Normalize all three to one idle edge and
 * collapse rapid duplicates before running idle-dependent native behavior. The
 * headless V2 server does not emit `session.idle` for an ordinary completed
 * turn (only `session.execution.succeeded`), so omitting the latter left the
 * todo-continuation gate permanently unarmed in the lab.
 */
export function createNativeIdleGate({ now = () => Date.now(), windowMs = 500 } = {}) {
  const recent = new Map()
  return {
    accept(event) {
      const sessionID = eventSessionID(event)
      const idle = event?.type === "session.idle"
        || (event?.type === "session.status" && event?.properties?.status === "idle")
        || event?.type === "session.execution.succeeded"
      if (!sessionID || !idle) return undefined
      const timestamp = now()
      const previous = recent.get(sessionID)
      recent.set(sessionID, timestamp)
      if (typeof previous === "number" && timestamp - previous < windowMs) return undefined
      return { type: "session.idle", sessionID }
    },
    clear(sessionID) {
      recent.delete(sessionID)
    },
    clearAll() {
      recent.clear()
    },
  }
}

/**
 * Native V2 replacement for the V1 Anthropic context-window recovery hook.
 * The host owns compaction execution; the plugin requests it once per active
 * token-limit incident through the documented `session.compact` service.
 */
export function createNativeContextLimitRecovery({ session, log = console.error } = {}) {
  const pending = new Set()
  return {
    async handle(event) {
      const sessionID = eventSessionID(event)
      if (!sessionID) return false
      if (event?.type === "session.deleted" || event?.type === "session.compacted") {
        pending.delete(sessionID)
        return false
      }
      if (event?.type !== "session.error" || !TOKEN_LIMIT_PATTERN.test(eventMessage(event)) || pending.has(sessionID)) return false
      if (typeof session?.compact !== "function") return false
      pending.add(sessionID)
      try {
        await session.compact({ sessionID })
        log(`[oh-my-rigel] Native V2 context recovery requested compaction: session=${sessionID}`)
        return true
      } catch (error) {
        pending.delete(sessionID)
        log(`[oh-my-rigel] Native V2 context recovery failed: session=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    clear(sessionID) {
      pending.delete(sessionID)
    },
    clearAll() {
      pending.clear()
    },
  }
}

/**
 * Atlas work and unstable background children are observable through the V2
 * event feed and the native background manager. Synthetic messages are queued
 * by the host instead of writing directly into a V1 prompt session.
 */
export function createNativeIdleContinuations({ session, backgroundManager, resolveAgent } = {}) {
  const notified = new Set()
  return {
    async handle(event) {
      const sessionID = event?.sessionID
      if (typeof sessionID !== "string" || !sessionID || typeof session?.synthetic !== "function") return false
      const active = backgroundManager?.activeCount?.(sessionID) ?? 0
      if (active === 0 || notified.has(sessionID)) return false
      const agent = typeof resolveAgent === "function" ? await resolveAgent({ sessionID }) : undefined
      const role = String(agent ?? "").toLowerCase()
      const text = role.includes("atlas")
        ? `Atlas has ${active} active background task${active === 1 ? "" : "s"}. Continue the tracked work only after their results arrive.`
        : `Background work is still active (${active} task${active === 1 ? "" : "s"}). Wait for its completion notification instead of polling.`
      await session.synthetic({ sessionID, text })
      notified.add(sessionID)
      return true
    },
    clear(sessionID) {
      notified.delete(sessionID)
    },
    clearAll() {
      notified.clear()
    },
  }
}
