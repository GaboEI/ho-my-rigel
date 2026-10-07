import { describe, expect, test } from "bun:test"
import { createOpenclawOutbound } from "./rigel-v2-native-openclaw-outbound.mjs"

function stubRegistry() {
  const registered = []
  const removed = []
  return {
    registered,
    removed,
    register: async (mapping) => { registered.push(mapping); return true },
    removeSession: async (sessionID) => { removed.push(sessionID); return 1 },
    lookup: () => null,
    prune: async () => 0,
    hydrate: async () => {},
    size: () => registered.length,
  }
}

function httpConfig(overrides = {}) {
  return {
    enabled: true,
    gateways: { hook: { url: "https://gateway.test/hook" } },
    hooks: { "session.idle": { gateway: "hook", instruction: "notify {{event}} {{sessionId}}" } },
    ...overrides,
  }
}

describe("openclaw outbound", () => {
  test("a disabled or absent config is a strict no-op", async () => {
    let called = 0
    const outbound = createOpenclawOutbound({ config: undefined, registry: stubRegistry(), fetchImpl: async () => { called += 1 } })
    expect(await outbound.handleEvent({ type: "session.idle", sessionID: "s1" })).toBeNull()
    const disabled = createOpenclawOutbound({ config: { enabled: false }, registry: stubRegistry(), fetchImpl: async () => { called += 1 } })
    expect(await disabled.handleEvent({ type: "session.idle", sessionID: "s1" })).toBeNull()
    expect(called).toBe(0)
  })

  test("session.idle dispatches the configured hook payload and registers correlation", async () => {
    let captured
    const registry = stubRegistry()
    const outbound = createOpenclawOutbound({
      config: httpConfig(),
      registry,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      fetchImpl: async (url, init) => {
        captured = JSON.parse(init.body)
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{"messageId":"m1","platform":"discord"}' }
      },
    })
    const result = await outbound.handleEvent({ type: "session.idle", sessionID: "s1", projectPath: "/home/me/proj" })
    expect(result.success).toBe(true)
    expect(captured).toEqual({
      event: "session.idle",
      instruction: "notify session.idle s1",
      text: "notify session.idle s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "s1",
      projectPath: "/home/me/proj",
      projectName: "proj",
      context: { sessionId: "s1", projectPath: "/home/me/proj" },
    })
    expect(registry.registered).toHaveLength(1)
    expect(registry.registered[0]).toMatchObject({ sessionID: "s1", messageId: "m1", platform: "discord-bot" })
  })

  test("the first hook that resolves a gateway wins, so the alias is not also dispatched", async () => {
    let calls = 0
    const outbound = createOpenclawOutbound({
      config: {
        enabled: true,
        gateways: { primary: { url: "https://g.test/a" }, alias: { url: "https://g.test/b" } },
        hooks: { "session.idle": { gateway: "primary", instruction: "p" }, stop: { gateway: "alias", instruction: "a" } },
      },
      registry: stubRegistry(),
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => "{}" } },
    })
    await outbound.handleEvent({ type: "session.idle", sessionID: "s1" })
    expect(calls).toBe(1)
  })

  test("a subagent session.created is skipped", async () => {
    let calls = 0
    const outbound = createOpenclawOutbound({
      config: { enabled: true, gateways: { h: { url: "https://g.test/a" } }, hooks: { "session.created": { gateway: "h", instruction: "x" } } },
      registry: stubRegistry(),
      isSubagentSession: (sessionID) => sessionID === "child",
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => "{}" } },
    })
    expect(await outbound.handleEvent({ type: "session.created", sessionID: "child" })).toBeNull()
    expect(calls).toBe(0)
    await outbound.handleEvent({ type: "session.created", sessionID: "main" })
    expect(calls).toBe(1)
  })

  test("session.deleted removes the session mappings and never correlates", async () => {
    const registry = stubRegistry()
    const outbound = createOpenclawOutbound({
      config: { enabled: true, gateways: { h: { url: "https://g.test/a" } }, hooks: { "session.deleted": { gateway: "h", instruction: "x" } } },
      registry,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"messageId":"m1","platform":"discord"}' }),
    })
    await outbound.handleEvent({ type: "session.deleted", sessionID: "s1" })
    expect(registry.removed).toEqual(["s1"])
    expect(registry.registered).toHaveLength(0)
  })

  test("an unknown event is ignored", async () => {
    let calls = 0
    const outbound = createOpenclawOutbound({ config: httpConfig(), registry: stubRegistry(), fetchImpl: async () => { calls += 1 } })
    expect(await outbound.handleEvent({ type: "session.error", sessionID: "s1" })).toBeNull()
    expect(calls).toBe(0)
  })

  test("a command gateway receives shell-escaped variables", async () => {
    let argv
    const outbound = createOpenclawOutbound({
      config: { enabled: true, gateways: { c: { type: "command", command: "notify {{event}}" } }, hooks: { "session.idle": { gateway: "c", instruction: "ignored" } } },
      registry: stubRegistry(),
      platform: "win32",
      spawnImpl: (args) => { argv = args; return { pid: 1, stdout: { [Symbol.asyncIterator]: async function* () {} }, exited: Promise.resolve(0), kill() {} } },
    })
    await outbound.handleEvent({ type: "session.idle", sessionID: "s1" })
    expect(argv[2]).toBe("notify 'session.idle'")
  })

  test("env reply-channel fallbacks reach the HTTP payload", async () => {
    let captured
    const outbound = createOpenclawOutbound({
      config: httpConfig(),
      registry: stubRegistry(),
      env: { OPENCLAW_REPLY_CHANNEL: "discord", OPENCLAW_REPLY_TARGET: "user-1", OPENCLAW_REPLY_THREAD: "th-1" },
      fetchImpl: async (_url, init) => { captured = JSON.parse(init.body); return { ok: true, status: 200, text: async () => "{}" } },
    })
    await outbound.handleEvent({ type: "session.idle", sessionID: "s1" })
    expect(captured.channel).toBe("discord")
    expect(captured.to).toBe("user-1")
    expect(captured.threadId).toBe("th-1")
  })
})
