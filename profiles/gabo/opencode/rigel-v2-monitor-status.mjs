/**
 * Native OpenCode V2 monitor-status injector.
 *
 * V1 parity of `packages/omo-opencode/src/hooks/monitor-status-injector/hook.ts`:
 * the status of the session's ACTIVE monitors is injected into the orchestrator
 * turn so the model sees what it is watching and the `monitor_stop` hint, without
 * ever exposing a raw command.
 *
 * Adaptation: the injector is a consumer of the native monitor registry
 * (`tools/monitor-engine.mjs`, storage/PTY/event backed) and runs on the official
 * `context` hook (`context.session.hook("context", event)`), after the team
 * injectors, under the `monitor.enabled` gate owned by the runtime wiring. It
 * operates on `event.messages` (V2 provider-shaped messages: `role` + `content`
 * as a string or an array of `{ type: "text", text }` parts).
 *
 * Reconciliation contract (a full reconcile, not an append):
 *   - registry absent (gate off or no verified server) -> no-op.
 *   - one or more ACTIVE monitors -> strip every inherited/malformed block,
 *     then inject exactly ONE fresh block at the head of the last real user
 *     message. Successive turns and repeated hook runs never stack.
 *   - ZERO active monitors -> strip every inherited block and restore the
 *     surrounding text byte-for-byte (removing the separator the injector added),
 *     so a stopped monitor can no longer be reported as active.
 *   - session isolation: the registry owner scopes `list(sessionID)`.
 *   - the raw command is never emitted; only id / label / status / matched count.
 */

export const MONITOR_STATUS_PREFIX = "Active monitors:"
export const MONITOR_STATUS_OPEN = "<monitor-status>"
export const MONITOR_STATUS_CLOSE = "</monitor-status>"

const BLOCK_SEPARATOR = "\n\n---\n\n"

function isActiveMonitor(record) {
  return record?.status === "running" || record?.status === "starting"
}

function isRealUserMessage(message) {
  return message?.role === "user" && message.synthetic !== true && message.internal !== true
}

/** The exact V1 status line: `Active monitors: <id> (<label>, <status>, <N> matched), ... - call monitor_stop to stop`. */
export function formatMonitorStatusLine(records) {
  const items = records.map((record) => {
    const matched = Number.isFinite(record?.counters?.matchedLines) ? record.counters.matchedLines : 0
    return `${record.id} (${record.label}, ${record.status}, ${matched} matched)`
  })
  return `${MONITOR_STATUS_PREFIX} ${items.join(", ")} - call monitor_stop to stop`
}

export function buildMonitorStatusBlock(records) {
  return `${MONITOR_STATUS_OPEN}\n${formatMonitorStatusLine(records)}\n${MONITOR_STATUS_CLOSE}`
}

/** Locate the first well-formed block in a text. Returns `{ start, end }` or undefined. */
export function findMonitorStatusBlock(content) {
  if (typeof content !== "string") return undefined
  const start = content.indexOf(MONITOR_STATUS_OPEN)
  if (start === -1) return undefined
  const close = content.indexOf(MONITOR_STATUS_CLOSE, start + MONITOR_STATUS_OPEN.length)
  if (close === -1) return undefined
  return { start, end: close + MONITOR_STATUS_CLOSE.length }
}

/**
 * Strip every monitor-status block from a text, including duplicated and
 * malformed ones (an open tag with no close is removed up to the separator the
 * injector added, or to the end of the text). A well-formed block that the
 * injector prepended also consumes the following separator, so the original
 * text is restored byte-for-byte. Returns `{ text, removed }`.
 */
export function stripMonitorStatusBlocks(content) {
  if (typeof content !== "string" || content.indexOf(MONITOR_STATUS_OPEN) === -1) {
    return { text: content, removed: false }
  }
  let out = ""
  let index = 0
  let removed = false
  while (index < content.length) {
    const open = content.indexOf(MONITOR_STATUS_OPEN, index)
    if (open === -1) {
      out += content.slice(index)
      break
    }
    out += content.slice(index, open)
    removed = true
    const close = content.indexOf(MONITOR_STATUS_CLOSE, open + MONITOR_STATUS_OPEN.length)
    let end
    if (close === -1) {
      const separator = content.indexOf(BLOCK_SEPARATOR, open)
      end = separator === -1 ? content.length : separator + BLOCK_SEPARATOR.length
    } else {
      end = close + MONITOR_STATUS_CLOSE.length
      if (content.slice(end, end + BLOCK_SEPARATOR.length) === BLOCK_SEPARATOR) end += BLOCK_SEPARATOR.length
    }
    index = end
  }
  return { text: out, removed }
}

/** Every writable text slot of a message: the string content, or each text part of an array. */
function textSlots(message) {
  const content = message?.content
  if (typeof content === "string") {
    return [{ get: () => content, set: (value) => { message.content = value } }]
  }
  if (Array.isArray(content)) {
    const slots = []
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        slots.push({ get: () => part.text, set: (value) => { part.text = value } })
      }
    }
    return slots
  }
  return []
}

/**
 * Reconcile the whole message list to `block` (or to no block when `block` is
 * empty): strip every inherited block, then inject exactly one fresh block at
 * the head of the last real user message. Returns true when a slot changed.
 * Exposed for the wiring contract.
 */
export function reconcileMonitorStatus(event, block) {
  if (!Array.isArray(event?.messages) || event.messages.length === 0) return false
  let mutated = false
  for (const message of event.messages) {
    for (const slot of textSlots(message)) {
      const { text, removed } = stripMonitorStatusBlocks(slot.get())
      if (removed) {
        slot.set(text)
        mutated = true
      }
    }
  }
  if (!block) return mutated
  const message = [...event.messages].reverse().find(isRealUserMessage)
  if (!message) return mutated
  const slots = textSlots(message)
  if (slots.length === 0) return mutated
  const slot = slots[0]
  slot.set(`${block}${BLOCK_SEPARATOR}${slot.get()}`)
  return true
}

/**
 * Build the `context`-hook injector. `getRegistry` is a getter (the registry is
 * created inside `tool.transform`, after this factory runs) returning the native
 * monitor registry or undefined. A missing registry or a malformed event is a
 * silent no-op, so an ordinary session pays nothing.
 */
export function createNativeMonitorStatusInjector({ getRegistry } = {}) {
  if (typeof getRegistry !== "function") {
    throw new Error("native monitor status injector requires a registry getter")
  }
  return async (event) => {
    if (!Array.isArray(event?.messages) || event.messages.length === 0) return false
    if (typeof event.sessionID !== "string" || event.sessionID.length === 0) return false
    const registry = getRegistry()
    if (!registry || typeof registry.list !== "function") return false
    const records = await registry.list(event.sessionID)
    const active = (Array.isArray(records) ? records : []).filter(isActiveMonitor)
    const block = active.length > 0 ? buildMonitorStatusBlock(active) : ""
    return reconcileMonitorStatus(event, block)
  }
}
