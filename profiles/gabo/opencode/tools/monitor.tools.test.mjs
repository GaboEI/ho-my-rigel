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
// get/set/remove/scan contract the registry consumes.
function fakeStorage() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.get(key) },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan(prefix) {
      return [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))
    },
  }
}

// A fake V2 pty domain: create returns an id; snapshot returns canned text.
function fakePty({ snapshotText = "" } = {}) {
  const calls = { create: [], remove: [], snapshot: [] }
  let counter = 0
  return {
    calls,
    async create(input) { calls.create.push(input); counter += 1; return { data: { id: `pty_${counter}` } } },
    async remove(input) { calls.remove.push(input) },
    async snapshot(input) { calls.snapshot.push(input); return { data: { text: snapshotText } } },
  }
}

// A fake V2 session domain that records delivered monitor prompts.
function fakeSessions() {
  const prompts = []
  return { prompts, async prompt(input) { prompts.push(input); return { data: {} } } }
}

function registryFor({ storage = fakeStorage(), pty = fakePty(), sessions = fakeSessions(), config = {} } = {}) {
  return createMonitorRegistry({ storage, pty, event: undefined, sessions, config })
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

test("monitor_start spawns a pty, persists a record, and returns the V1 block", async () => {
  const storage = fakeStorage()
  const pty = fakePty()
  const registry = registryFor({ storage, pty, config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  const output = await monitor_start.execute({ command: "tail -f log", label: "logs" }, { sessionID: "ses_1" })
  expect(output).toContain("Monitor started successfully.")
  expect(output).toContain("monitor_id: mon_pty_1")
  expect(output).toContain("label: logs")
  expect(pty.calls.create[0].command).toBe("tail -f log")
  expect(storage.map.size).toBe(1)
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
  const pty = fakePty()
  const registry = registryFor({ pty, config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_stop } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log" }, { sessionID: "ses_1" })
  expect(JSON.parse(await monitor_stop.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))).toEqual({ status: "stopped", monitor_id: "mon_pty_1" })
  expect(JSON.parse(await monitor_stop.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))).toEqual({ status: "already-stopped", monitor_id: "mon_pty_1" })
  expect(JSON.parse(await monitor_stop.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_2" }))).toEqual({ status: "denied", monitor_id: "mon_pty_1" })
  expect(pty.calls.remove[0]).toEqual({ ptyID: "pty_1" })
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

test("monitor_output returns not_found for an unknown or unauthorized monitor", async () => {
  const registry = registryFor({ config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log" }, { sessionID: "ses_1" })
  expect(JSON.parse(await monitor_output.execute({ monitor_id: "mon_missing" }, { sessionID: "ses_1" })).error).toBe("not_found")
  expect(JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_2" })).error).toBe("not_found")
})

test("monitor_output reads live pty output, filters it, and reports counters", async () => {
  const pty = fakePty({ snapshotText: "INFO ok\nERROR boom\nINFO ok" })
  const registry = registryFor({ pty, config: { enabled: true, allowed_commands: ["tail"] } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } } })
  await monitor_start.execute({ command: "tail -f log", match_pattern: "ERROR" }, { sessionID: "ses_1" })
  const output = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))
  expect(output.counters.totalLines).toBe(3)
  expect(output.counters.matchedLines).toBe(1)
  expect(output.counters.unmatchedLines).toBe(2)
  const matched = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1", stream: "matched" }, { sessionID: "ses_1" }))
  expect(matched.lines.map((line) => line.text)).toEqual(["ERROR boom"])
})

test("monitor registry transitions a record to exited on a pty.exited event", async () => {
  const registry = registryFor({ config: { enabled: true, allowed_commands: ["tail"] } })
  await registry.start({ command: "tail -f log", mode: "idle", parentSessionId: "ses_1" })
  await registry.handleEvent({ type: "pty.exited", data: { info: { id: "pty_1", exitCode: 0 } } })
  const record = await registry.get("mon_pty_1")
  expect(record.status).toBe("exited")
  expect(record.exitCode).toBe(0)
})

test("monitor registry shutdown stops every running monitor", async () => {
  const pty = fakePty()
  const registry = registryFor({ pty, config: { enabled: true, allowed_commands: ["tail"] } })
  await registry.start({ command: "tail -f a", mode: "idle", parentSessionId: "ses_1" })
  await registry.start({ command: "tail -f b", mode: "idle", parentSessionId: "ses_1" })
  await registry.shutdown()
  expect(pty.calls.remove.length).toBe(2)
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
  const pty = fakePty({ snapshotText: "ERROR boom" })
  const sessions = fakeSessions()
  const registry = registryFor({ pty, sessions, config: { enabled: true, allowed_commands: ["tail"], batch_max_lines: 1 } })
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
  const pty = fakePty({ snapshotText: "line" })
  const registry = registryFor({ pty, sessions: {}, config: { enabled: true, allowed_commands: ["tail"], batch_max_lines: 1 } })
  const { monitor_start, monitor_output } = createMonitorTools({ registry, pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"], batch_max_lines: 1 } } })
  await monitor_start.execute({ command: "tail -f log" }, { sessionID: "ses_1" })
  // A missing prompt must not throw out of the tool; the read still returns.
  const output = JSON.parse(await monitor_output.execute({ monitor_id: "mon_pty_1" }, { sessionID: "ses_1" }))
  expect(output.counters.totalLines).toBe(1)
})

test("monitor registry stops a session's monitors on session.deleted", async () => {
  const pty = fakePty()
  const registry = registryFor({ pty, config: { enabled: true, allowed_commands: ["tail"] } })
  await registry.start({ command: "tail -f a", mode: "idle", parentSessionId: "ses_1" })
  await registry.handleEvent({ type: "session.deleted", data: { sessionID: "ses_1" } })
  expect(pty.calls.remove.length).toBe(1)
  expect((await registry.get("mon_pty_1")).status).toBe("stopped")
})
