/**
 * Native OpenCode V2 monitor engine.
 *
 * Ports the observable semantics of `packages/omo-opencode/src/features/monitor/`
 * onto V2 primitives. It is NOT a no-op: a monitor is a real V2 PTY process
 * whose output is decoded, filtered, ring-buffered, and persisted through the
 * V2 storage domain, with lifecycle observed through the V2 event stream.
 *
 * V2 primitive mapping:
 *   - process spawn/stop  -> `context.pty.create` / `context.pty.remove`
 *   - output read         -> `context.pty.snapshot({ ptyID })`
 *   - lifecycle events    -> `context.event.subscribe` (`pty.exited`)
 *   - durable records     -> `context.storage.get/set/remove/scan`
 *   - output delivery     -> `context.session.prompt` (batched, V1 envelope)
 *
 * V1-equivalent delivery is preserved: ingested lines feed a `MonitorBatcher`
 * (max lines / max bytes / interval) whose batches are injected into the parent
 * session as internal prompts through `deliverMonitorBatch`, exactly as V1's
 * `MonitorOutputInjector` did through the prompt gate. `monitor_output` remains
 * available for on-demand reads, but it is no longer the only delivery path.
 */

import { MonitorBatcher, deliverMonitorBatch } from "./monitor-delivery.mjs"

export const DEFAULT_MONITOR_CONFIG = Object.freeze({
  enabled: false,
  live_mode_enabled: false,
  max_monitors_per_session: 3,
  max_runtime_ms: 1800000,
  batch_max_lines: 50,
  batch_max_bytes: 16384,
  flush_interval_ms: 1000,
  ring_max_lines: 1000,
  line_max_bytes: 8192,
  pattern_max_length: 512,
})

const STORAGE_PREFIX = "ho-my-rigel.monitor."
const ANSI_COLOR_PATTERN = /\x1b\[[0-9;]*m/g

function stripAnsi(text) {
  return String(text).replace(ANSI_COLOR_PATTERN, "")
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function getMonitorConfig(pluginConfig) {
  const monitor = isPlainObject(pluginConfig?.monitor) ? pluginConfig.monitor : {}
  return { ...DEFAULT_MONITOR_CONFIG, ...monitor }
}

export function getEffectiveMode(requestedMode, liveModeEnabled) {
  if (requestedMode === "live_safe" && !liveModeEnabled) {
    return { mode: "idle", note: 'requested mode "live_safe" was coerced to "idle" because monitor.live_mode_enabled is false' }
  }
  return { mode: requestedMode ?? "idle" }
}

export function createEmptyCounters() {
  return { totalLines: 0, matchedLines: 0, unmatchedLines: 0, droppedMatched: 0, droppedUnmatched: 0, bytesDropped: 0, lastSequence: 0 }
}

// --- ReDoS-safe filter, ported from features/monitor/filter.ts ---

function scanQuantifier(pattern, index) {
  const ch = pattern[index]
  if (ch === "*" || ch === "+") {
    const lazy = pattern[index + 1] === "?" ? 1 : 0
    return { length: 1 + lazy, repeated: true, unbounded: true }
  }
  if (ch === "?") return { length: 1, repeated: false, unbounded: false }
  if (ch === "{") {
    const close = pattern.indexOf("}", index)
    if (close === -1) return { length: 0, repeated: false, unbounded: false }
    const braceMatch = /^(\d+)(,(\d*))?$/.exec(pattern.slice(index + 1, close))
    if (!braceMatch) return { length: 0, repeated: false, unbounded: false }
    const min = Number(braceMatch[1])
    const hasComma = braceMatch[2] !== undefined
    const maxRaw = braceMatch[3]
    const unbounded = hasComma && (maxRaw === undefined || maxRaw === "")
    const max = unbounded ? Number.POSITIVE_INFINITY : hasComma && maxRaw ? Number(maxRaw) : min
    const lazy = pattern[close + 1] === "?" ? 1 : 0
    return { length: close - index + 1 + lazy, repeated: unbounded || max >= 2, unbounded }
  }
  return { length: 0, repeated: false, unbounded: false }
}

function isPotentiallyCatastrophicRegex(pattern) {
  const groupStack = []
  let inCharClass = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === "\\") { i += 1; continue }
    if (inCharClass) { if (ch === "]") inCharClass = false; continue }
    if (ch === "[") { inCharClass = true; continue }
    if (ch === "(") { groupStack.push({ hasUnboundedQuant: false }); continue }
    if (ch === ")") {
      const frame = groupStack.pop()
      const quant = scanQuantifier(pattern, i + 1)
      if (quant.repeated && frame?.hasUnboundedQuant) return true
      if (groupStack.length > 0 && (quant.unbounded || frame?.hasUnboundedQuant)) groupStack[groupStack.length - 1].hasUnboundedQuant = true
      i += quant.length
      continue
    }
    if (ch === "*" || ch === "+" || ch === "{") {
      const quant = scanQuantifier(pattern, i)
      if (quant.unbounded && groupStack.length > 0) groupStack[groupStack.length - 1].hasUnboundedQuant = true
      if (quant.length > 1) i += quant.length - 1
    }
  }
  return false
}

export function createMonitorFilter(pattern, opts) {
  if (!pattern) return { filter: { matches: () => true } }
  if (pattern.length > opts.patternMaxLength) return { filter: null, error: "pattern too long" }
  if (isPotentiallyCatastrophicRegex(pattern)) {
    return { filter: null, error: "unsafe pattern: nested quantifiers can cause catastrophic backtracking (ReDoS)" }
  }
  let re
  try {
    re = new RegExp(pattern)
  } catch (error) {
    return { filter: null, error: `invalid regex: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { filter: { matches: (text) => re.test(stripAnsi(text)) }, pattern }
}

// --- Ring buffer, ported from features/monitor/ring-buffer.ts ---

export class MonitorRingBuffer {
  constructor(opts) {
    this.ringMaxLines = opts.ringMaxLines
    this.matchedLines = []
    this.unmatchedLines = []
    this.counters = createEmptyCounters()
  }

  push(line, matched) {
    this.counters.totalLines += 1
    this.counters.lastSequence = Math.max(this.counters.lastSequence, line.seq)
    if (matched) {
      this.counters.matchedLines += 1
      this.pushInto(this.matchedLines, line, "droppedMatched")
      return
    }
    this.counters.unmatchedLines += 1
    this.pushInto(this.unmatchedLines, line, "droppedUnmatched")
  }

  pushInto(store, line, droppedKey) {
    if (store.length >= this.ringMaxLines) {
      const dropped = store.shift()
      if (dropped) {
        this.counters[droppedKey] += 1
        this.counters.bytesDropped += dropped.text.length
      }
    }
    store.push(line)
  }

  query(opts) {
    const lines = this.selectLines(opts.stream)
    const sinceFiltered = opts.since_sequence === undefined ? lines : lines.filter((line) => line.seq > opts.since_sequence)
    const limited = opts.limit === undefined ? sinceFiltered : sinceFiltered.slice(-opts.limit)
    return { lines: limited, counters: this.getCounters() }
  }

  getCounters() {
    return { ...this.counters }
  }

  selectLines(stream) {
    if (stream === "matched") return [...this.matchedLines]
    if (stream === "unmatched") return [...this.unmatchedLines]
    return [...this.matchedLines, ...this.unmatchedLines].sort((left, right) => left.seq - right.seq)
  }
}

// --- Permission gate, ported from features/monitor/permission.ts ---

function tokenizeCommand(command) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(String(command))) !== null) tokens.push(match[1] ?? match[2] ?? match[3])
  return tokens
}

export async function checkMonitorCommandPermission(command, ctx) {
  if (ctx.config.enabled === false) return { allowed: false, reason: "monitor feature disabled", via: "feature-disabled" }
  if (ctx.bashPermissionAsk) {
    try {
      await ctx.bashPermissionAsk({ permission: "bash", patterns: [command], always: [command], metadata: { command } })
      return { allowed: true, reason: "command allowed by bash permission", via: "bash-equivalent" }
    } catch (error) {
      return { allowed: false, reason: error instanceof Error && error.message ? error.message : "bash permission denied", via: "bash-equivalent" }
    }
  }
  const program = tokenizeCommand(command)[0]
  const allowedCommands = ctx.config.allowed_commands ?? []
  if (program && allowedCommands.includes(program)) return { allowed: true, reason: "command allowed by allowed_commands", via: "allowlist" }
  return { allowed: false, reason: "command not in allowed_commands", via: "allowlist" }
}

// --- Storage-backed monitor registry ---

function storageKey(monitorId) {
  return `${STORAGE_PREFIX}${monitorId}`
}

function ptyIdOf(response) {
  const data = response?.data ?? response
  return data?.id ?? data?.ptyID ?? data?.pty?.id
}

function snapshotText(response) {
  const data = response?.data ?? response
  if (typeof data?.text === "string") return data.text
  if (Array.isArray(data?.lines)) return data.lines.join("\n")
  return ""
}

/**
 * The monitor registry. Records live in the V2 storage domain so they survive
 * across tool calls within the session; the ring buffer is in-memory per
 * process (V1 kept it in memory too). `pty` and `storage` are the V2 domains.
 */
export function createMonitorRegistry({ storage, pty, event, sessions, config }) {
  const buffers = new Map()
  const stoppedIds = new Set()
  // Last snapshot text ingested per monitor, so a repeated `monitor_output`
  // read does not re-ingest the whole PTY buffer and duplicate lines.
  const ingestedText = new Map()

  const readRecord = async (monitorId) => {
    if (typeof storage?.get !== "function") return undefined
    const value = await storage.get(storageKey(monitorId))
    return isPlainObject(value) ? value : undefined
  }

  const writeRecord = async (record) => {
    if (typeof storage?.set !== "function") return
    await storage.set(storageKey(record.id), record)
  }

  const listRecords = async (sessionID) => {
    if (typeof storage?.scan !== "function") return []
    const entries = await storage.scan(STORAGE_PREFIX)
    const records = []
    const values = Array.isArray(entries) ? entries : Object.values(entries ?? {})
    for (const entry of values) {
      const record = isPlainObject(entry?.value) ? entry.value : isPlainObject(entry) ? entry : undefined
      if (!record || typeof record.id !== "string") continue
      if (sessionID && record.parentSessionId !== sessionID) continue
      records.push(record)
    }
    return records
  }

  const bufferFor = (monitorId) => {
    if (!buffers.has(monitorId)) buffers.set(monitorId, new MonitorRingBuffer({ ringMaxLines: config.ring_max_lines }))
    return buffers.get(monitorId)
  }

  // One batcher per monitor, ported from V1. Its batches are delivered to the
  // parent session as internal prompts, so output arrives automatically.
  const batchers = new Map()
  const runtimeTimers = new Map()
  const batcherFor = (monitorId) => {
    if (!batchers.has(monitorId)) {
      const batcher = new MonitorBatcher({
        batchMaxLines: config.batch_max_lines,
        batchMaxBytes: config.batch_max_bytes,
        flushIntervalMs: config.flush_interval_ms,
      })
      batcher.onBatch((batch) => {
        void deliverBatch(monitorId, batch)
      })
      batchers.set(monitorId, batcher)
    }
    return batchers.get(monitorId)
  }

  const deliverBatch = async (monitorId, batch) => {
    const record = await readRecord(monitorId)
    if (!record) return
    const buffer = bufferFor(monitorId)
    const counters = buffer.getCounters()
    try {
      await deliverMonitorBatch({ sessions, record, batch, counters })
    } catch (error) {
      console.error(`[ho-my-rigel] Native V2 monitor delivery failed: monitor=${monitorId}; ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const ingest = (monitorId, text, filter) => {
    const buffer = bufferFor(monitorId)
    const batcher = batcherFor(monitorId)
    const lines = String(text).split("\n")
    for (const raw of lines) {
      if (raw.length === 0) continue
      const seq = buffer.getCounters().lastSequence + 1
      const truncated = raw.length > config.line_max_bytes
      const line = { stream: "stdout", seq, text: truncated ? raw.slice(0, config.line_max_bytes) : raw, ...(truncated ? { truncated: true } : {}) }
      const matched = filter ? filter.matches(line.text) : true
      buffer.push(line, matched)
      // V1 delivered only matched lines automatically; unmatched lines stay in
      // the ring buffer for `monitor_output`. A monitor with no pattern matches
      // everything, so its output is delivered.
      if (matched) batcher.push(line)
    }
  }

  const clearRuntimeTimer = (monitorId) => {
    const timer = runtimeTimers.get(monitorId)
    if (timer) {
      clearTimeout(timer)
      runtimeTimers.delete(monitorId)
    }
  }

  const armRuntimeTimer = (monitorId) => {
    clearRuntimeTimer(monitorId)
    if (!(config.max_runtime_ms > 0)) return
    const timer = setTimeout(() => {
      runtimeTimers.delete(monitorId)
      void stopMonitor(monitorId, "max_runtime")
    }, config.max_runtime_ms)
    timer.unref?.()
    runtimeTimers.set(monitorId, timer)
  }

  const stopMonitor = async (monitorId, reason) => {
    const record = await readRecord(monitorId)
    if (!record) return
    clearRuntimeTimer(monitorId)
    if (record.ptyID && typeof pty?.remove === "function") {
      try { await pty.remove({ ptyID: record.ptyID }) } catch { /* already gone */ }
    }
    stoppedIds.add(monitorId)
    const batcher = batchers.get(monitorId)
    if (batcher) {
      // Flush any retained matched lines as a terminal batch before teardown.
      batcher.flushNow({ allowEmpty: false })
      batcher.destroy()
      batchers.delete(monitorId)
    }
    await writeRecord({ ...record, status: reason === "max_runtime" ? "stopped" : "stopped" })
  }

  return {
    async start({ command, label, mode, matchPattern, parentSessionId, parentMessageId }) {
      const existing = await listRecords(parentSessionId)
      const active = existing.filter((record) => record.status === "running" || record.status === "starting")
      if (active.length >= config.max_monitors_per_session) {
        throw new Error(`monitor capacity reached: ${active.length}/${config.max_monitors_per_session}`)
      }
      const created = await pty.create({ command, title: label ?? command, cwd: undefined })
      const ptyID = ptyIdOf(created)
      if (!ptyID) throw new Error("OpenCode V2 pty.create did not return a pty id")
      const id = `mon_${ptyID}`
      const record = {
        id,
        ptyID,
        command,
        label: label ?? command,
        mode,
        parentSessionId,
        parentMessageId,
        matchPattern,
        startedAt: new Date().toISOString(),
        status: "running",
        counters: createEmptyCounters(),
      }
      await writeRecord(record)
      bufferFor(id)
      batcherFor(id)
      armRuntimeTimer(id)
      return record
    },

    async stop(monitorId) {
      await stopMonitor(monitorId, "stopped")
    },

    async get(monitorId) {
      return readRecord(monitorId)
    },

    async list(sessionID) {
      return listRecords(sessionID)
    },

    async getOutput(monitorId, opts) {
      const record = await readRecord(monitorId)
      if (!record) return { lines: [], counters: createEmptyCounters() }
      const buffer = bufferFor(monitorId)
      // Refresh from the live PTY snapshot so output is real, not a no-op.
      if (record.status === "running" && record.ptyID && typeof pty?.snapshot === "function") {
        try {
          const snapshot = await pty.snapshot({ ptyID: record.ptyID })
          const text = snapshotText(snapshot)
          const previous = ingestedText.get(monitorId) ?? ""
          if (text && text !== previous) {
            // Ingest only the new suffix when the snapshot grew; a shrunk or
            // reset snapshot is ingested whole.
            const delta = text.startsWith(previous) ? text.slice(previous.length) : text
            const filterResult = createMonitorFilter(record.matchPattern, { patternMaxLength: config.pattern_max_length })
            ingest(monitorId, delta, filterResult.filter)
            ingestedText.set(monitorId, text)
          }
        } catch { /* pty may have exited */ }
      }
      const result = buffer.query({ stream: opts.stream ?? "all", since_sequence: opts.since_sequence, limit: opts.limit })
      await writeRecord({ ...record, counters: result.counters })
      return result
    },

    async stopSessionMonitors(sessionID) {
      const records = await listRecords(sessionID)
      for (const record of records) {
        if (record.status === "running") await stopMonitor(record.id, "session_deleted")
      }
    },

    async handleEvent(event) {
      // V1 stopped a session's monitors on session teardown.
      if (event?.type === "session.deleted") {
        const sessionID = event?.data?.sessionID ?? event?.data?.session?.id ?? event?.properties?.sessionID
        if (typeof sessionID === "string") await this.stopSessionMonitors(sessionID)
        return
      }
      const ptyID = event?.data?.info?.id ?? event?.data?.ptyID ?? event?.properties?.ptyID
      if (event?.type !== "pty.exited" || typeof ptyID !== "string") return
      const records = await listRecords(undefined)
      const record = records.find((candidate) => candidate.ptyID === ptyID)
      if (!record) return
      clearRuntimeTimer(record.id)
      const exitCode = event?.data?.info?.exitCode ?? event?.data?.exitCode
      await writeRecord({ ...record, status: "exited", ...(typeof exitCode === "number" ? { exitCode } : {}) })
      // Flush the terminal batch so the parent sees the final output.
      const batcher = batchers.get(record.id)
      if (batcher) {
        batcher.flushNow({ allowEmpty: false })
        batcher.destroy()
        batchers.delete(record.id)
      }
    },

    async shutdown() {
      const records = await listRecords(undefined)
      for (const record of records) {
        if (record.status === "running") await stopMonitor(record.id, "shutdown")
      }
    },

    isStopped(monitorId) {
      return stoppedIds.has(monitorId)
    },
  }
}
