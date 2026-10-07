import { describe, expect, test } from "bun:test"
import { createOpenclawInbound, createInternalPromptGate } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out: ${message}`)
}

function immediateSleep() {
  return new Promise((resolve) => setImmediate(resolve))
}

function registryWith(platform, messageId, sessionID) {
  const registry = createOpenclawRegistry({})
  registry.register({ sessionID, projectPath: "/p", platform, messageId, createdAt: new Date().toISOString() })
  return registry
}

function discordFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes("/reactions/")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" }
    return handler(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function discordListener(overrides = {}) {
  const delivered = []
  const registry = overrides.registry ?? registryWith("discord-bot", "botmsg", "ses_1")
  const fetchImpl = overrides.fetchImpl ?? discordFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: "m2", content: "hello", author: { id: "u1" }, message_reference: { message_id: "botmsg" } }],
    text: async () => "",
  }))
  const inbound = createOpenclawInbound({
    // Spread the caller overrides FIRST so the merged `replyListener` below is
    // not clobbered by `overrides.replyListener`; otherwise a per-test listener
    // override (e.g. includePrefix/rateLimit/maxMessageLength) would replace the
    // whole block and strip the credentials the listener needs to start.
    ...overrides,
    replyListener: {
      discordBotToken: "token",
      discordChannelId: "chan",
      authorizedDiscordUserIds: ["u1"],
      pollIntervalMs: 3000,
      rateLimitPerMinute: 10,
      maxMessageLength: 500,
      includePrefix: true,
      ...overrides.replyListener,
    },
    registry,
    deliverInboundReply: async (input) => { delivered.push(input); return true },
    fetchImpl,
    sleep: immediateSleep,
    log: () => {},
  })
  return { inbound, delivered, registry, fetchImpl }
}

describe("openclaw internal prompt gate", () => {
  test("delivers with the queue delivery and refuses empty input or a host without prompt", async () => {
    const prompts = []
    const gate = createInternalPromptGate({ session: { prompt: async (input) => { prompts.push(input); return { data: {} } } } })
    expect(await gate({ sessionID: "s1", text: "hi" })).toBe(true)
    expect(prompts).toEqual([{ sessionID: "s1", text: "hi", delivery: "queue" }])
    expect(await gate({ sessionID: "", text: "hi" })).toBe(false)
    expect(await gate({ sessionID: "s1", text: "" })).toBe(false)
    const noHost = createInternalPromptGate({ session: {} })
    expect(await noHost({ sessionID: "s1", text: "hi" })).toBe(false)
  })
})

describe("openclaw inbound listener", () => {
  test("no credentials means no listener and no request", async () => {
    let calls = 0
    const inbound = createOpenclawInbound({ replyListener: {}, registry: createOpenclawRegistry({}), deliverInboundReply: async () => true, fetchImpl: async () => { calls += 1 } })
    const result = await inbound.start()
    expect(result.started).toBe(false)
    expect(calls).toBe(0)
    expect(inbound.status().enabled).toBe(false)
  })

  test("a Discord reply quoting a registered outbound message reaches the session with the prefix", async () => {
    const { inbound, delivered, fetchImpl } = discordListener()
    await inbound.start()
    await waitFor(() => delivered.length > 0, "discord injection")
    expect(delivered[0]).toEqual({ sessionID: "ses_1", text: "[reply:discord] hello" })
    const ack = fetchImpl.calls.find((call) => call.url.includes("/reactions/"))
    expect(ack).toBeDefined()
    expect(ack.init.method).toBe("PUT")
    await inbound.stop()
    expect(inbound.status().messagesInjected).toBe(1)
  })

  test("includePrefix false drops the prefix", async () => {
    const { inbound, delivered } = discordListener({ replyListener: { includePrefix: false } })
    await inbound.start()
    await waitFor(() => delivered.length > 0, "discord injection")
    expect(delivered[0].text).toBe("hello")
    await inbound.stop()
  })

  test("an unauthorized author is ignored", async () => {
    const fetchImpl = discordFetch(async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => [{ id: "m2", content: "hello", author: { id: "intruder" }, message_reference: { message_id: "botmsg" } }],
    }))
    const { inbound, delivered } = discordListener({ fetchImpl })
    await inbound.start()
    await waitFor(() => fetchImpl.calls.some((call) => call.url.includes("/messages?")), "discord poll")
    await inbound.stop()
    expect(delivered).toHaveLength(0)
  })

  test("the rate limiter drops the message beyond the cap", async () => {
    const fetchImpl = discordFetch(async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => [
        { id: "m2", content: "one", author: { id: "u1" }, message_reference: { message_id: "botmsg" } },
        { id: "m3", content: "two", author: { id: "u1" }, message_reference: { message_id: "botmsg" } },
      ],
    }))
    const { inbound, delivered } = discordListener({ fetchImpl, replyListener: { rateLimitPerMinute: 1 } })
    await inbound.start()
    await waitFor(() => delivered.length > 0, "first injection")
    await inbound.stop()
    expect(delivered).toHaveLength(1)
    expect(inbound.status().errors).toBeGreaterThanOrEqual(1)
  })

  test("a reply longer than maxMessageLength is truncated", async () => {
    const fetchImpl = discordFetch(async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => [{ id: "m2", content: "x".repeat(100), author: { id: "u1" }, message_reference: { message_id: "botmsg" } }],
    }))
    const { inbound, delivered } = discordListener({ fetchImpl, replyListener: { maxMessageLength: 20 } })
    await inbound.start()
    await waitFor(() => delivered.length > 0, "injection")
    await inbound.stop()
    expect(delivered[0].text.length).toBe(20)
  })

  test("a Telegram reply quoting a registered message reaches the session", async () => {
    const delivered = []
    const calls = []
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init })
      if (url.includes("getUpdates")) {
        return {
          ok: true, status: 200, text: async () => "",
          json: async () => ({ result: [{ update_id: 5, message: { message_id: 9, chat: { id: "chat" }, text: "tg hello", reply_to_message: { message_id: "tg-bot" } } }] }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" }
    }
    const inbound = createOpenclawInbound({
      replyListener: { telegramBotToken: "t", telegramChatId: "chat" },
      registry: registryWith("telegram", "tg-bot", "ses_tg"),
      deliverInboundReply: async (input) => { delivered.push(input); return true },
      fetchImpl, sleep: immediateSleep, log: () => {},
    })
    await inbound.start()
    await waitFor(() => delivered.length > 0, "telegram injection")
    expect(delivered[0]).toEqual({ sessionID: "ses_tg", text: "[reply:telegram] tg hello" })
    const ack = calls.find((call) => call.url.includes("sendMessage"))
    expect(ack.init.method).toBe("POST")
    await inbound.stop()
  })

  test("stop aborts the loop and no further poll happens", async () => {
    const { inbound, fetchImpl } = discordListener({ fetchImpl: discordFetch(async () => ({ ok: true, status: 200, json: async () => [], text: async () => "" })) })
    await inbound.start()
    await waitFor(() => fetchImpl.calls.length > 0, "first poll")
    await inbound.stop()
    const after = fetchImpl.calls.length
    await new Promise((resolve) => setImmediate(resolve))
    expect(fetchImpl.calls.length).toBe(after)
    expect(inbound.status().started).toBe(false)
  })
})
