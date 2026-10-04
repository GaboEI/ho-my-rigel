import { expect, test } from "bun:test"
import { createMonitorTools } from "./monitor.tools.mjs"
import {
  createMonitorRegistry,
  createMonitorFilter,
  MonitorRingBuffer,
  checkMonitorCommandPermission,
  getEffectiveMode,
} from "./monitor-engine.mjs"
import { MonitorBatcher, formatMonitorBatch } from "./monitor-delivery.mjs"

// A fake V2 storage domain: an in-memory key/value map with the real
// get/set/remove/scan contract the registry consumes. `scan` takes the
// canonical `{ prefix, limit, after }` object form and returns paginated
// `{ entries, next }` pages; it throws if a caller passes a bare string.
function fakeStorage({ pageSize = 100 } = {}) {
  const map = new Map()
  const scanCalls = []
  return {
    map,
    scanCalls,
    async get(key) { return map.get(key) },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan(opts = {}) {
      scanCalls.push(opts)
      if (typeof opts !== "object" || opts === null || Array.isArray(opts) || typeof opts.prefix !== "string") {
        throw new TypeError("monitor storage.scan must receive an object with a string prefix")
      }
      const limit = Math.min(opts.limit ?? pageSize, pageSize)
      const keys = [...map.keys()].filter((key) => key.startsWith(opts.prefix)).sort()
      const start = opts.after ? keys.indexOf(opts.after) + 1 : 0
      const slice = keys.slice(start, start + limit)
      const nextIndex = start + slice.length
      return {
        entries: slice.map((key) => ({ key, value: map.get(key) })),
        ...(nextIndex < keys.length ? { next: keys[nextIndex - 1] } : {}),
      }
    },
  }
}

// A fake persistent-terminal port with the terminal-driver contract:
// start -> { ok, ptyID, info }, snapshot -> { ok, text, info },
// remove -> { ok }. The snapshot text/info is mutable so a test can simulate a
// live process growing its output or exiting between reads. `factory` is the
// session-scoped `terminalFactory(sessionID) -> port`.
function fakeTerminal({ snapshotText = "", info } = {}) {
  const calls = { start: [], remove: [], snapshot: [], factory: [] }
  const state = { text: snapshotText, info }
  let counter = 0
  const port = {
    async start(input) {
      calls.start.push(input)
      counter += 1
      return { ok: true, ptyID: `pty_${counter}`, info: { id: `pty_${counter}` } }
    },
    async snapshot(input) {
      calls.snapshot.push(input)
      return { ok: true, text: state.text, info: state.info }
    },
    async remove(input) {
      calls.remove.push(input)
      return { ok: true }
    },
  }
  return {
    calls,
    state,
    port,
    factory(sessionID) { calls.factory.push(sessionID); return port },
  }
}

// A fake V2 session domain that records delivered monitor prompts.
function fakeSessions() {
  const prompts = []
  return { prompts, async prompt(input) { prompts.push(input); return { data: {} } } }
}

function registryFor({ storage = fakeStorage(), terminal = fakeTerminal(), sessions = fakeSessions(), config = {} } = {}) {
  return createMonitorRegistry({ storage, terminalFactory: terminal.factory, event: undefined, sessions, config })
}

test("monitor filter accepts a plain pattern and rejects a ReDoS pattern", () => {
  expect(createMonitorFilter(undefined, { patternMaxLength: 512 }).filter.matches("anything")).toBe(true)
  expect(createMonitorFilter("ERROR", { patternMaxLength: 512 }).filter.matches("an ERROR line")).toBe(true)
  expect(createMonitorFilter("(a+)+$", { patternMaxLength: 512 }).filter).toBe(null)
  expect(createMonitorFilter("x".repeat(600), { patternMaxLength: 512 }).error).toBe("pattern too long")
})

test("monitor ring buffer tracks matched/unmatched counters and drops", () => {
  const buffer = new MonitorRingBuffer({ ringMaxLines: 2 })
  buffer.push({ stream: "stdout", seq: 1, text: "a" }, true)
  buffer.push({ stream: "stdout", seq: 2, text: "b" }, false)
  buffer.push({ stream: "stdout", seq: 3, text: "c" }, true)
  buffer.push({ stream: "stdout", seq: 4, text: "d" }, true)
  const counters = buffer.getCounters()
  expect(counters.totalLines).toBe(4)
  expect(counters.matchedLines).toBe(3)
  expect(counters.unmatchedLines).toBe(1)
  expect(counters.droppedMatched).toBe(1)
  expect(counters.lastSequence).toBe(4)
  const matched = buffer.query({ stream: "matched" })
  expect(matched.lines.map((line) => line.text)).toEqual(["c", "d"])
})

test("monitor permission fails closed to the allowlist without a bash ask", async () => {
  const denied = await checkMonitorCommandPermission("rm -rf /", { config: { enabled: true, allowed_commands: ["tail"] } })
  expect(denied.allowed).toBe(false)
  expect(denied.via).toBe("allowlist")
  const allowed = await checkMonitorCommandPermission("tail -f log", { config: { enabled: true, allowed_commands: ["tail"] } })
  expect(allowed.allowed).toBe(true)
})

test("monitor permission uses the bash-equivalent ask when available", async () => {
  const asked = []
  const result = await checkMonitorCommandPermission("tail -f log", {
    config: { enabled: true },
    bashPermissionAsk: async (input) => { asked.push(input) },
  })
  expect(result.allowed).toBe(true)
  expect(result.via).toBe("bash-equivalent")
  expect(asked[0].permission).toBe("bash")
})

test("monitor permission denies when the feature is disabled", async () => {
  const result = await checkMonitorCommandPermission("tail -f log", { config: { enabled: false } })
  expect(result.allowed).toBe(false)
  expect(result.via).toBe("feature-disabled")
})

test("monitor live_safe coerces to idle when live mode is disabled", () => {
  expect(getEffectiveMode("live_safe", false)).toMatchObject({ mode: "idle" })
  expect(getEffectiveMode("live_safe", false).note).toContain("coerced")
  expect(getEffectiveMode("live_safe", true)).toEqual({ mode: "live_safe" })
  expect(getEffectiveMode(undefined, false)).toEqual({ mode: "idle" })
})

test("monitor_start starts a persistent terminal, persists a record, and returns the V1 block", async () => {
  const storage = fakeStorage()
  const terminal = fakeTerminal()
  const registry = registryFor({ storage, terminal, config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  const output = await monitor_start.execute({ command: "tail -f log", label: "logs" }, { sessionID: "ses_1" })
  expect(output).toContain("Monitor started successfully.")
  expect(output).toContain("monitor_id: mon_pty_1")
  expect(output).toContain("label: logs")
  expect(terminal.calls.start[0].command).toBe(process.env.SHELL || "/bin/sh")
  expect(terminal.calls.start[0].args).toEqual(["-c", "tail -f log"])
  expect(terminal.calls.factory).toEqual(["ses_1"])
  expect(storage.map.size).toBe(1)
  expect((await registry.get("mon_pty_1")).ptyID).toBe("pty_1")
})

test("monitor_start denies a command outside the allowlist", async () => {
  const registry = registryFor({ config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  const output = await monitor_start.execute({ command: "rm -rf /" }, { sessionID: "ses_1" })
  expect(output).toContain("[ERROR] monitor_start denied")
})

test("monitor_start rejects an unsafe match_pattern", async () => {
  const registry = registryFor({ config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  const output = await monitor_start.execute({ command: "tail -f log", match_pattern: "(a+)+$" }, { sessionID: "ses_1" })
  expect(output).toContain("[ERROR] monitor_start match_pattern rejected")
})

test("monitor_start enforces the per-session capacity", async () => {
  const registry = registryFor({ config: { enabled: true, allowed_commands: ["tail"], max_monitors_per_session: 1 } })
  const { monitor_start } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"], max_monitors_per_session: 1 } } })
  await monitor_start.execute({ command: "tail -f a" }, { sessionID: "ses_1" })
  const second = await monitor_start.execute({ command: "tail -f b" }, { sessionID: "ses_1" })
  expect(second).toContain("[ERROR] monitor_start failed")
})

test("monitor_stop returns stopped, then already-stopped, and denies another session", async () => {
  const terminal = fakeTerminal()
  const registry = registryFor({ terminal, config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_stop } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log" }, { sessionID: "ses_1" })
  expect(JSON.parse(await monitor_stop.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))).toEqual({ status: "stopped", monitor_id: "mon_pty_1" })
  expect(JSON.parse(await monitor_stop.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))).toEqual({ status: "already-stopped", monitor_id: "mon_pty_1" })
  expect(JSON.parse(await monitor_stop.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_2" }))).toEqual({ status: "denied", monitor_id: "mon_pty_1" })
  expect(terminal.calls.remove[0]).toEqual({ ptyID: "pty_1" })
})

test("monitor_list hides exited monitors unless include_exited is set", async () => {
  const registry = registryFor({ config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_list } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log", label: "logs" }, { sessionID: "ses_1" })
  const visible = JSON.parse(await monitor_list.execute({}, { sessionID: "ses_1" }))
  expect(visible.monitors.length).toBe(1)
  expect(visible.monitors[0].label).toBe("logs")
  expect(visible.monitors[0].command).toBeUndefined()
  await registry.stop("mon_pty_1")
  expect(JSON.parse(await monitor_list.execute({}, { sessionID: "ses_1" })).monitors.length).toBe(0)
  expect(JSON.parse(await monitor_list.execute({ include_exited: true }, { sessionID: "ses_1" })).monitors.length).toBe(1)
})

test("monitor registry scans storage with the object form and paginates pages", async () => {
  const storage = fakeStorage({ pageSize: 1 })
  const registry = registryFor({ storage, config: { enabled: true, allowed_commands: ["tail"] } })
  await registry.start({ command: "tail -f a", mode: "idle", parentSessionId: "ses_1" })
  await registry.start({ command: "tail -f b", mode: "idle", parentSessionId: "ses_1" })
  storage.scanCalls.length = 0
  const records = await registry.list("ses_1")
  expect(records.map((record) => record.id).sort()).toEqual(["mon_pty_1", "mon_pty_2"])
  expect(storage.scanCalls.length).toBeGreaterThanOrEqual(2)
  for (const call of storage.scanCalls) {
    expect(typeof call).toBe("object")
    expect(typeof call.prefix).toBe("string")
  }
})

test("monitor registry tolerates a scan that returns a bare array", async () => {
  const map = new Map([
    ["oh-my-rigel.monitor.mon_1", { id: "mon_1", parentSessionId: "ses_1", status: "running" }],
    ["oh-my-rigel.monitor.mon_2", { id: "mon_2", parentSessionId: "ses_2", status: "running" }],
  ])
  const storage = {
    async get(key) { return map.get(key) },
    async set(key, value) { map.set(key, value) },
    async scan(opts) {
      if (typeof opts !== "object" || opts === null || typeof opts.prefix !== "string") {
        throw new TypeError("monitor storage.scan must receive an object with a string prefix")
      }
      return [...map.entries()].filter(([key]) => key.startsWith(opts.prefix)).map(([key, value]) => ({ key, value }))
    },
  }
  const registry = registryFor({ storage, config: { enabled: true, allowed_commands: ["tail"] } })
  expect((await registry.list("ses_1")).map((record) => record.id)).toEqual(["mon_1"])
})

test("monitor_output returns not_found for an unknown or unauthorized monitor", async () => {
  const registry = registryFor({ config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log" }, { sessionID: "ses_1" })
  expect(JSON.parse(await monitor_output.execute({ monitor_id: "mon_missing" }, { sessionID: "ses_1" })).error).toBe("not_found")
  expect(JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_2" })).error).toBe("not_found")
})

test("monitor_output reads the live terminal snapshot, filters it, and reports counters", async () => {
  const terminal = fakeTerminal({ snapshotText: "INFO ok\nERROR boom\nINFO ok" })
  const registry = registryFor({ terminal, config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log", match_pattern: "ERROR" }, { sessionID: "ses_1" })
  const output = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))
  expect(output.counters.totalLines).toBe(3)
  expect(output.counters.matchedLines).toBe(1)
  expect(output.counters.unmatchedLines).toBe(2)
  const matched = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1", stream: "matched" }, { sessionID: "ses_1" }))
  expect(matched.lines.map((line) => line.text)).toEqual(["ERROR boom"])
  const unmatched = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1", stream: "unmatched" }, { sessionID: "ses_1" }))
  expect(unmatched.lines.map((line) => line.text)).toEqual(["INFO ok", "INFO ok"])
  const all = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1", stream: "all" }, { sessionID: "ses_1" }))
  expect(all.lines.map((line) => line.seq)).toEqual([1, 2, 3])
})

test("monitor_output derives the exited transition from the terminal snapshot and flushes the terminal batch", async () => {
  const terminal = fakeTerminal({ snapshotText: "ERROR boom" })
  const sessions = fakeSessions()
  const registry = registryFor({ terminal, sessions, config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log", match_pattern: "ERROR" }, { sessionID: "ses_1" })
  // The process exits before the read: the snapshot arrives with exited status.
  // The retained line is flushed as the terminal batch (stillRunning=false).
  terminal.state.info = { status: "exited", exitCode: 7 }
  const output = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))
  expect(output.counters.matchedLines).toBe(1)
  const record = await registry.get("mon_pty_1")
  expect(record.status).toBe("exited")
  expect(record.exitCode).toBe(7)
  expect(sessions.prompts.length).toBe(1)
  expect(sessions.prompts[0].text).toContain("Status: exited")
  expect(sessions.prompts[0].text).toContain("code=7")
})

test("monitor_start throws a clear error when no terminal factory is provided", async () => {
  const registry = createMonitorRegistry({ storage: fakeStorage(), event: undefined, sessions: fakeSessions(), config: {} })
  await expect(registry.start({ command: "tail -f log", mode: "idle", parentSessionId: "ses_1" })).rejects.toThrow(/persistent-terminal/)
})

test("monitor registry shutdown stops every running monitor", async () => {
  const terminal = fakeTerminal()
  const registry = registryFor({ terminal, config: { enabled: true, allowed_commands: ["tail"] } })
  await registry.start({ command: "tail -f a", mode: "idle", parentSessionId: "ses_1" })
  await registry.start({ command: "tail -f b", mode: "idle", parentSessionId: "ses_1" })
  await registry.shutdown()
  expect(terminal.calls.remove.length).toBe(2)
})

// Task 15 re-open: V1-equivalent delivery. V1 injected batched monitor output
// into the parent session as an internal prompt; V2 delivers the same batch
// through session.prompt. These tests prove the delivery path is real, not
// on-demand only.

test("monitor batcher flushes on the line cap and emits the V1 envelope", () => {
  const batches = []
  const batcher = new MonitorBatcher({ batchMaxLines: 2, batchMaxBytes: 1_000_000, flushIntervalMs: 0 })
  batcher.onBatch((batch) => batches.push(batch))
  batcher.push({ stream: "stdout", seq: 1, text: "a" })
  batcher.push({ stream: "stdout", seq: 2, text: "b" })
  expect(batches.length).toBe(1)
  expect(batches[0].lines.map((line) => line.text)).toEqual(["a", "b"])
  const envelope = formatMonitorBatch({ id: "mon_1", label: "logs", status: "running" }, batches[0], { droppedMatched: 0, droppedUnmatched: 0, bytesDropped: 0 })
  expect(envelope).toContain("[OMO MONITOR OUTPUT]")
  expect(envelope).toContain("stream_policy: untrusted_observation")
  expect(envelope).toContain("[stdout seq=1] a")
  expect(envelope).toContain("[END OMO MONITOR OUTPUT]")
})

test("monitor output is delivered to the parent session automatically", async () => {
  const terminal = fakeTerminal({ snapshotText: "ERROR boom" })
  const sessions = fakeSessions()
  const registry = registryFor({ terminal, sessions, config: { enabled: true, allowed_commands: ["tail"], batch_max_lines: 1 } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"], batch_max_lines: 1 } } })
  await monitor_start.execute({ command: "tail -f log", match_pattern: "ERROR" }, { sessionID: "ses_1" })
  // A read ingests the live snapshot, which feeds the batcher and delivers.
  await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" })
  expect(sessions.prompts.length).toBe(1)
  expect(sessions.prompts[0].sessionID).toBe("ses_1")
  expect(sessions.prompts[0].text).toContain("[OMO MONITOR OUTPUT]")
  expect(sessions.prompts[0].text).toContain("ERROR boom")
})

test("monitor delivery is skipped when the session domain cannot prompt", async () => {
  const terminal = fakeTerminal({ snapshotText: "line" })
  const registry = registryFor({ terminal, sessions: {}, config: { enabled: true, allowed_commands: ["tail"], batch_max_lines: 1 } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"], batch_max_lines: 1 } } })
  await monitor_start.execute({ command: "tail -f log" }, { sessionID: "ses_1" })
  // A missing prompt must not throw out of the tool; the read still returns.
  const output = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))
  expect(output.counters.totalLines).toBe(1)
})

test("monitor registry stops a session's monitors on session.deleted", async () => {
  const terminal = fakeTerminal()
  const registry = registryFor({ terminal, config: { enabled: true, allowed_commands: ["tail"] } })
  await registry.start({ command: "tail -f a", mode: "idle", parentSessionId: "ses_1" })
  await registry.handleEvent({ type: "session.deleted", data: { sessionID: "ses_1" } })
  expect(terminal.calls.remove.length).toBe(1)
  expect((await registry.get("mon_pty_1")).status).toBe("stopped")
})

test("monitor registry applies default limits when the config omits monitor keys", async () => {
  const registry = createMonitorRegistry({ storage: fakeStorage(), terminalFactory: fakeTerminal().factory, event: undefined, sessions: fakeSessions(), config: {} })
  await registry.start({ command: "tail -f a", mode: "idle", parentSessionId: "ses_1" })
  await registry.start({ command: "tail -f b", mode: "idle", parentSessionId: "ses_1" })
  await registry.start({ command: "tail -f c", mode: "idle", parentSessionId: "ses_1" })
  await expect(registry.start({ command: "tail -f d", mode: "idle", parentSessionId: "ses_1" })).rejects.toThrow(/capacity reached/)
})

test("monitor batcher marks a terminal flush as not running", () => {
  const batches = []
  const batcher = new MonitorBatcher({ batchMaxLines: 10, batchMaxBytes: 1_000_000, flushIntervalMs: 0 })
  batcher.onBatch((batch) => batches.push(batch))
  batcher.push({ stream: "stdout", seq: 1, text: "a" })
  batcher.flushNow({ allowEmpty: false, stillRunning: false })
  expect(batches.at(-1).stillRunning).toBe(false)
})
