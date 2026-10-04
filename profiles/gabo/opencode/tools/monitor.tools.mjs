/**
 * Native OpenCode V2 `monitor_*` tools.
 *
 * The engine (PTY spawn, ring buffer, filter, permission, storage-backed
 * registry) lives in `monitor-engine.mjs`; this module holds only the four tool
 * definitions and their V1-observable result formats.
 *
 * Preserved V1 behavior:
 *   - `monitor_start`: command permission gate, `match_pattern` validation,
 *     `live_safe` -> `idle` coercion, per-session capacity, and the exact
 *     `Monitor started successfully.` block.
 *   - `monitor_stop`: `stopped` / `already-stopped` / `denied` JSON results.
 *   - `monitor_list`: session-scoped, hides exited/stopped/failed unless
 *     `include_exited`, never returns raw commands.
 *   - `monitor_output`: session-scoped ownership check, `not_found` JSON result,
 *     matched/unmatched/all streams, `since_sequence`, `limit`, and counters.
 */

import {
  createMonitorFilter,
  checkMonitorCommandPermission,
  getMonitorConfig,
  getEffectiveMode,
  createEmptyCounters,
} from "./monitor-engine.mjs"

function formatStartResult({ monitorId, label, mode, maxMonitorsPerSession, maxRuntimeMs, note }) {
  const noteLine = note ? `\nnote: ${note}` : ""
  return `Monitor started successfully.

monitor_id: ${monitorId}
label: ${label}
mode: ${mode}
caps: max_monitors_per_session=${maxMonitorsPerSession}, max_runtime_ms=${maxRuntimeMs}${noteLine}

To stop this monitor, call monitor_stop with monitor_id="${monitorId}".

output arrives automatically — do not poll`
}

const EMPTY_COUNTERS = createEmptyCounters()

function createNotFoundResult() {
  return { lines: [], counters: { ...EMPTY_COUNTERS }, error: "not_found" }
}

const hiddenStatuses = new Set(["exited", "stopped", "failed"])

function formatMonitor(record) {
  return {
    id: record.id,
    label: record.label,
    mode: record.mode,
    startedAt: record.startedAt,
    status: record.status,
    counters: {
      matched: record.counters?.matchedLines ?? 0,
      unmatched: record.counters?.unmatchedLines ?? 0,
      droppedMatched: record.counters?.droppedMatched ?? 0,
      droppedUnmatched: record.counters?.droppedUnmatched ?? 0,
      bytesDropped: record.counters?.bytesDropped ?? 0,
      lastSequence: record.counters?.lastSequence ?? 0,
    },
  }
}

/**
 * Build the four monitor tools. `registry` is the storage/pty/event-backed
 * engine; `pluginConfig` carries the `monitor` block read from the config
 * adapter (never parsed here).
 */
export function createMonitorTools({ registry, pluginConfig }) {
  const monitorConfig = getMonitorConfig(pluginConfig)

  const monitor_start = {
    description: "Start a non-interactive background monitor command. Output is delivered automatically to the parent session; use labels instead of raw commands in transcripts.",
    input: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run in the background monitor" },
        label: { type: "string", description: "Safe human-facing label for the monitor" },
        mode: { type: "string", enum: ["idle", "live_safe"], description: "Delivery mode. idle is safe default; live_safe requires monitor.live_mode_enabled." },
        match_pattern: { type: "string", description: "Optional JavaScript regex. Matching lines are delivered automatically." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args = {}, toolContext = {}) {
      const permission = await checkMonitorCommandPermission(args.command, {
        config: monitorConfig,
        ...(typeof toolContext?.ask === "function" ? { bashPermissionAsk: toolContext.ask } : {}),
      })
      if (!permission.allowed) return `[ERROR] monitor_start denied: ${permission.reason}`
      const filterResult = createMonitorFilter(args.match_pattern, { patternMaxLength: monitorConfig.pattern_max_length })
      if (!filterResult.filter) return `[ERROR] monitor_start match_pattern rejected: ${filterResult.error ?? "invalid pattern"}`
      const effectiveMode = getEffectiveMode(args.mode, monitorConfig.live_mode_enabled)
      try {
        const record = await registry.start({
          command: args.command,
          label: args.label,
          mode: effectiveMode.mode,
          matchPattern: args.match_pattern,
          parentSessionId: toolContext?.sessionID,
          parentMessageId: toolContext?.messageID,
        })
        return formatStartResult({
          monitorId: record.id,
          label: record.label,
          mode: effectiveMode.mode,
          maxMonitorsPerSession: monitorConfig.max_monitors_per_session,
          maxRuntimeMs: monitorConfig.max_runtime_ms,
          note: effectiveMode.note,
        })
      } catch {
        return `[ERROR] monitor_start failed for label: ${args.label ?? "(manager-assigned label)"}`
      }
    },
  }

  const monitor_stop = {
    description: "Stop a running monitor owned by the current session.",
    input: {
      type: "object",
      properties: { monitor_id: { type: "string", description: "Monitor ID to stop" } },
      required: ["monitor_id"],
      additionalProperties: false,
    },
    async execute(args = {}, toolContext = {}) {
      const record = await registry.get(args.monitor_id)
      if (!record) return JSON.stringify({ status: "already-stopped", monitor_id: args.monitor_id })
      if (record.parentSessionId !== toolContext?.sessionID) return JSON.stringify({ status: "denied", monitor_id: args.monitor_id })
      if (record.status === "stopped" || registry.isStopped(args.monitor_id)) {
        return JSON.stringify({ status: "already-stopped", monitor_id: args.monitor_id })
      }
      await registry.stop(args.monitor_id)
      return JSON.stringify({ status: "stopped", monitor_id: args.monitor_id })
    },
  }

  const monitor_list = {
    description: `List monitors owned by the current session.

Returns id, label, mode, startedAt, status, and counters. Raw commands are never included.`,
    input: {
      type: "object",
      properties: { include_exited: { type: "boolean", description: "Include exited, stopped, and failed monitors. Defaults to false." } },
      additionalProperties: false,
    },
    async execute(args = {}, toolContext = {}) {
      const includeExited = args.include_exited ?? false
      const records = await registry.list(toolContext?.sessionID)
      const monitors = records.filter((record) => includeExited || !hiddenStatuses.has(record.status)).map(formatMonitor)
      return JSON.stringify({ monitors })
    },
  }

  const monitor_output = {
    description: `Retrieve retained monitor output for the calling session.

Returns both output lines and counters so agents can detect dropped lines. Unknown or unauthorized monitor IDs return a not_found result instead of throwing.`,
    input: {
      type: "object",
      properties: {
        monitor_id: { type: "string", description: "Monitor ID to read output from" },
        stream: { type: "string", enum: ["matched", "unmatched", "all"], description: "Which retained stream to return: matched, unmatched, or all. Defaults to all." },
        since_sequence: { type: "number", description: "Return only lines with seq greater than this value" },
        limit: { type: "number", description: "Maximum number of retained lines to return" },
      },
      required: ["monitor_id"],
      additionalProperties: false,
    },
    async execute(args = {}, toolContext = {}) {
      const record = await registry.get(args.monitor_id)
      if (!record || record.parentSessionId !== toolContext?.sessionID) return JSON.stringify(createNotFoundResult())
      const output = await registry.getOutput(args.monitor_id, {
        stream: args.stream ?? "all",
        ...(args.since_sequence === undefined ? {} : { since_sequence: args.since_sequence }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return JSON.stringify(output)
    },
  }

  return { monitor_start, monitor_stop, monitor_list, monitor_output }
}

export { formatStartResult, formatMonitor }
