import { describe, expect, test } from "bun:test"

import { createNativeToolFamilies } from "./rigel-v2-native-tools.mjs"
import { createNativeMonitorStatusInjector, MONITOR_STATUS_PREFIX } from "./rigel-v2-monitor-status.mjs"

// In-memory stand-in for the isolated V2 storage domain the monitor registry
// persists into (`get` / `set` / `scan({ prefix })`).
function memoryStorage() {
  const map = new Map()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan({ prefix, limit } = {}) {
      const entries = [...map.entries()]
        .filter(([key]) => typeof prefix !== "string" || key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }))
      return { entries: Number.isInteger(limit) ? entries.slice(0, limit) : entries, next: undefined }
    },
  }
}

// Minimal server API the persistent-terminal port consumes: `createTerminal`
// returns a PTY id, the rest are inert. This is the same shape the tool gate
// audit drives, extended only by the one method `monitor_start` needs.
function fakeServerApi() {
  return {
    available: true,
    origin: "http://127.0.0.1:1",
    async createTerminal() {
      return { ok: true, data: { data: { id: "pty_1" } } }
    },
    async listTerminals() {
      return { ok: true, data: { data: [] } }
    },
    async snapshotTerminal() {
      return { ok: true, data: { data: { text: "", info: { status: "running" } } } }
    },
    async removeTerminal() {
      return { ok: true }
    },
    async raw() {
      return { ok: false, data: null, error: { code: "unused", message: "unused" } }
    },
  }
}

function fakeContext(storage) {
  return {
    session: {
      list: async () => ({ data: [] }),
      get: async () => ({ data: undefined }),
      context: async () => ({ data: [] }),
      prompt: async () => ({ data: {} }),
      create: async () => ({ data: { id: "ses_child" } }),
    },
    storage,
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  }
}

function gatesOnManifest() {
  return { metadata: { global: { gates: { monitor: true, goal: false, task_system: false, team_mode: false, interactive_bash: false, hashline_edit: false } } } }
}

function gatesOffManifest() {
  return { metadata: { global: { gates: { monitor: false, goal: false, task_system: false, team_mode: false, interactive_bash: false, hashline_edit: false } } } }
}

function buildFamilies(manifest, storage) {
  return createNativeToolFamilies({
    clients: [fakeContext(storage)],
    location: { directory: "/work" },
    manifest,
    context: fakeContext(storage),
    pluginConfig: { monitor: { enabled: true } },
    serverApi: fakeServerApi(),
  })
}

function blockTexts(messages) {
  return messages
    .flatMap((message) => (typeof message.content === "string" ? [message.content] : (message.content ?? []).map((part) => part?.text ?? "")))
    .filter((text) => typeof text === "string" && text.includes(MONITOR_STATUS_PREFIX))
}

describe("native monitor status wiring", () => {
  test("#given a real registry monitor #when the context hook runs #then the status block lands in the orchestrator turn", async () => {
    // given: the aggregator builds the real registry for a gates-on manifest
    const storage = memoryStorage()
    const families = buildFamilies(gatesOnManifest(), storage)
    expect(families.registry).toBeDefined()
    const started = await families.tools.monitor_start.execute(
      { command: "sleep 300", label: "watcher" },
      { sessionID: "ses_orch", ask: async () => {} },
    )
    expect(started).toContain("Monitor started successfully.")

    const injector = createNativeMonitorStatusInjector({ getRegistry: () => families.registry })
    const event = { sessionID: "ses_orch", messages: [{ role: "user", content: "continue" }] }

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(true)
    const [block] = blockTexts(event.messages)
    expect(block).toContain("watcher")
    expect(block).toContain("running")
    expect(block).toContain("monitor_stop")
    expect(block).not.toContain("sleep 300")
  })

  test("#given the monitor gate is off #when the aggregator runs #then no registry exists and injection is a no-op", async () => {
    // given
    const storage = memoryStorage()
    const families = buildFamilies(gatesOffManifest(), storage)
    expect(families.registry).toBeUndefined()
    expect(families.tools.monitor_start).toBeUndefined()

    const injector = createNativeMonitorStatusInjector({ getRegistry: () => families.registry })
    const event = { sessionID: "ses_orch", messages: [{ role: "user", content: "continue" }] }
    const before = structuredClone(event)

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(false)
    expect(event).toEqual(before)
  })

  test("#given the monitor block only in the manifest #when monitor_start runs #then the permission gate reads the materialized block", async () => {
    // given: the V2 setup context does not carry `[opencode].monitor`, so the
    // resolved block lives in the manifest; `pluginConfig` is empty here.
    const storage = memoryStorage()
    const manifest = {
      metadata: {
        global: {
          gates: { monitor: true, goal: false, task_system: false, team_mode: false, interactive_bash: false, hashline_edit: false },
          monitor: { enabled: true, allowed_commands: ["sleep"] },
        },
      },
    }
    const families = createNativeToolFamilies({
      clients: [fakeContext(storage)],
      location: { directory: "/work" },
      manifest,
      context: fakeContext(storage),
      pluginConfig: {},
      serverApi: fakeServerApi(),
    })

    // when
    const started = await families.tools.monitor_start.execute({ command: "sleep 300", label: "watcher" }, { sessionID: "ses_orch" })

    // then
    expect(started).toContain("Monitor started successfully.")
    expect(started).not.toContain("feature disabled")
  })

  test("#given an active monitor in one session #when another session's turn runs #then the registry scopes the status per session", async () => {
    // given
    const storage = memoryStorage()
    const families = buildFamilies(gatesOnManifest(), storage)
    await families.tools.monitor_start.execute(
      { command: "sleep 300", label: "watcher" },
      { sessionID: "ses_a", ask: async () => {} },
    )
    const injector = createNativeMonitorStatusInjector({ getRegistry: () => families.registry })
    const event = { sessionID: "ses_b", messages: [{ role: "user", content: "continue" }] }
    const before = structuredClone(event)

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(false)
    expect(event).toEqual(before)
  })

  test("#given the last monitor stops #when the context hook runs on the same turn #then the block is removed from the real registry", async () => {
    // given a real monitor started through the aggregator
    const storage = memoryStorage()
    const families = buildFamilies(gatesOnManifest(), storage)
    const started = await families.tools.monitor_start.execute(
      { command: "sleep 300", label: "watcher" },
      { sessionID: "ses_orch", ask: async () => {} },
    )
    const monitorId = /mon_[A-Za-z0-9_]+/.exec(started)?.[0]
    expect(monitorId).toBeString()
    const injector = createNativeMonitorStatusInjector({ getRegistry: () => families.registry })
    const original = "continue\n\n---\n\nwith the plan"
    const event = { sessionID: "ses_orch", messages: [{ role: "user", content: original }] }
    await injector(event)
    expect(event.messages[0].content).toContain("watcher")

    // when the only monitor stops and the hook reconciles again on the same turn
    await families.tools.monitor_stop.execute({ monitor_id: monitorId }, { sessionID: "ses_orch" })
    const mutated = await injector(event)

    // then no false "active monitors" line remains and the text is restored
    expect(mutated).toBe(true)
    expect(event.messages[0].content).not.toContain("Active monitors:")
    expect(event.messages[0].content).toBe(original)
  })
})
