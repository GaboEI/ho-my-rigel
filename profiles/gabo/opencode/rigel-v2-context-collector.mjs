const PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 }
const CONTEXT_SEPARATOR = "\n\n---\n\n"

export function createNativeContextCollector() {
  const sessions = new Map()
  let registrationOrder = 0

  function pending(sessionID) {
    const entries = [...(sessions.get(sessionID)?.values() ?? [])]
      .sort((left, right) => {
        const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
        return priority || left.registrationOrder - right.registrationOrder
      })
    return {
      entries,
      merged: entries.map((entry) => entry.content).join(CONTEXT_SEPARATOR),
      hasContent: entries.length > 0,
    }
  }

  return {
    register(sessionID, { id, source, content, priority = "normal", metadata } = {}) {
      if (typeof sessionID !== "string" || !sessionID || typeof id !== "string" || !id) return
      if (!(priority in PRIORITY_ORDER) || typeof source !== "string" || typeof content !== "string") return
      const entries = sessions.get(sessionID) ?? new Map()
      sessions.set(sessionID, entries)
      entries.set(`${source}:${id}`, { id, source, content, priority, metadata, registrationOrder: ++registrationOrder })
    },
    getPending: pending,
    consume(sessionID) {
      const result = pending(sessionID)
      sessions.delete(sessionID)
      return result
    },
    clear(sessionID) {
      sessions.delete(sessionID)
    },
    clearAll() {
      sessions.clear()
    },
    hasPending(sessionID) {
      return (sessions.get(sessionID)?.size ?? 0) > 0
    },
  }
}

function isRealUserMessage(message) {
  return message?.role === "user" && message.synthetic !== true && message.internal !== true
}

function prependContext(message, merged) {
  if (typeof message.content === "string") {
    message.content = `${merged}${CONTEXT_SEPARATOR}${message.content}`
    return true
  }
  if (!Array.isArray(message.content)) return false
  const text = message.content.find((part) => part?.type === "text" && typeof part.text === "string")
  if (!text) return false
  text.text = `${merged}${CONTEXT_SEPARATOR}${text.text}`
  return true
}

export function createNativeContextMessageConsumer(collector) {
  return async (event) => {
    if (!Array.isArray(event?.messages) || typeof event.sessionID !== "string") return false
    const message = [...event.messages].reverse().find(isRealUserMessage)
    if (!message || !collector.hasPending(event.sessionID)) return false
    const pending = collector.getPending(event.sessionID)
    if (!pending.hasContent || !prependContext(message, pending.merged)) return false
    collector.consume(event.sessionID)
    return true
  }
}
