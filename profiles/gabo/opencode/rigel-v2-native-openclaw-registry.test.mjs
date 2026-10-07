import { describe, expect, test } from "bun:test"
import { createOpenclawRegistry, OPENCLAW_REGISTRY_PREFIX } from "./rigel-v2-native-openclaw-registry.mjs"

function memoryStorage() {
  const map = new Map()
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value) },
    remove: async (key) => { map.delete(key) },
    scan: async ({ prefix } = {}) => ({
      entries: [...map.entries()]
        .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
        .map(([key, value]) => ({ key, value })),
    }),
  }
}

const mapping = (overrides = {}) => ({
  sessionID: "ses_1",
  projectPath: "/p",
  platform: "discord-bot",
  messageId: "m1",
  channelId: "c1",
  // Current time by default: the TTL is 24h and `lookup` lazily hides a stale
  // mapping, so a fixed past date would make every in-memory lookup look stale.
  // The TTL cases inject `createdAt` and a clock explicitly.
  createdAt: new Date().toISOString(),
  ...overrides,
})

describe("openclaw registry", () => {
  test("register then lookup by (platform, messageId), persisting under the namespace", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })
    expect(await registry.register(mapping())).toBe(true)
    expect(registry.lookup("discord-bot", "m1")).toMatchObject({ sessionID: "ses_1" })
    expect(registry.lookup("discord-bot", "missing")).toBeNull()
    expect([...storage.map.keys()].every((key) => key.startsWith(OPENCLAW_REGISTRY_PREFIX))).toBe(true)
  })

  test("an invalid mapping is rejected and never resolves", async () => {
    const registry = createOpenclawRegistry({})
    expect(await registry.register({ sessionID: "s" })).toBe(false)
    expect(registry.lookup("discord-bot", "m1")).toBeNull()
  })

  test("discord normalizes to discord-bot on write", async () => {
    const registry = createOpenclawRegistry({})
    await registry.register(mapping({ platform: "discord" }))
    expect(registry.lookup("discord-bot", "m1")).not.toBeNull()
    expect(registry.lookup("discord", "m1")).toBeNull()
  })

  test("a hydrated registry sees a mapping another instance persisted", async () => {
    const storage = memoryStorage()
    const writer = createOpenclawRegistry({ storage })
    await writer.register(mapping({ messageId: "m2" }))
    const reader = createOpenclawRegistry({ storage })
    await reader.hydrate()
    expect(reader.lookup("discord-bot", "m2")).toMatchObject({ sessionID: "ses_1" })
  })

  test("prune drops entries past the TTL and lookup hides a stale mapping", async () => {
    let clock = Date.parse("2026-01-02T00:00:00.000Z")
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage, now: () => clock })
    await registry.register(mapping({ createdAt: "2026-01-01T00:00:00.000Z" }))
    expect(registry.lookup("discord-bot", "m1")).not.toBeNull()
    clock = Date.parse("2026-01-03T00:00:00.000Z")
    expect(registry.lookup("discord-bot", "m1")).toBeNull()
    await registry.register(mapping({ messageId: "m3", createdAt: "2026-01-01T00:00:00.000Z" }))
    expect(await registry.prune()).toBe(1)
  })

  test("removeSession removes only that session's mappings", async () => {
    const registry = createOpenclawRegistry({})
    await registry.register(mapping({ messageId: "a" }))
    await registry.register(mapping({ messageId: "b", sessionID: "ses_2" }))
    expect(await registry.removeSession("ses_1")).toBe(1)
    expect(registry.lookup("discord-bot", "a")).toBeNull()
    expect(registry.lookup("discord-bot", "b")).not.toBeNull()
  })
})
