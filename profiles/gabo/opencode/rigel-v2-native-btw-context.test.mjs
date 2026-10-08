/**
 * Unit contract for the native V2 BTW parent-context injector.
 *
 * Pins both surfaces: the pure injector (metadata match -> bounded injection +
 * receipt; metadata miss -> byte-identical event, no receipt) and the
 * `context.session.hook("context", ...)` installer wiring.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BTW_BOUNDARY_SENTINEL,
  BTW_PARENT_CONTEXT_MAX_BYTES,
  BTW_PARENT_CONTEXT_MAX_MESSAGES,
  BTW_SIDE_METADATA_KEY,
  createBtwSideMetadata,
} from "./rigel-v2-btw-core.mjs"
import {
  BTW_INJECTION_RECEIPT_FILE,
  createBtwContextInjector,
  createBtwContextInstaller,
  resolveBtwReceiptPath,
  writeBtwInjectionReceipt,
} from "./rigel-v2-native-btw-context.mjs"

const SIDE_METADATA = { [BTW_SIDE_METADATA_KEY]: createBtwSideMetadata({ parentSessionID: "ses_main", boundaryMessageID: "msg_9" }) }

function parentMessages(count, text = "parent line") {
  return Array.from({ length: count }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: `${text} ${index}` }))
}

function metadataEvent() {
  return {
    sessionID: "ses_side",
    agent: "sisyphus",
    model: { modelID: "m" },
    system: [{ type: "text", text: "base system" }],
    messages: [{ role: "user", content: "side question" }],
    tools: [],
    options: {},
  }
}

describe("#given the pure BTW context injector", () => {
  test("#when the session carries the metadata #then bounded parent context + boundary are injected once", async () => {
    // given
    const receipts = []
    const injector = createBtwContextInjector({
      readSession: async () => ({ id: "ses_side", metadata: SIDE_METADATA }),
      readParentMessages: async () => parentMessages(3),
      writeReceipt: (receipt) => receipts.push(receipt),
      log: () => {},
    })
    const event = metadataEvent()

    // when
    const injected = await injector(event)

    // then
    expect(injected).toBe(true)
    expect(event.system[0].text).toContain(BTW_BOUNDARY_SENTINEL)
    expect(event.system[0].text).toContain("ses_main")
    expect(event.messages).toHaveLength(4)
    expect(event.messages.at(-1)).toEqual({ role: "user", content: "side question" })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ sessionID: "ses_side", injected: true, parentSessionID: "ses_main", messages: 3 })
    expect(receipts[0].bytes).toBeGreaterThan(0)
  })

  test("#when the session has NO metadata #then the event is byte-identical and no receipt is written", async () => {
    // given
    const receipts = []
    const injector = createBtwContextInjector({
      readSession: async () => ({ id: "ses_side" }),
      readParentMessages: async () => parentMessages(3),
      writeReceipt: (receipt) => receipts.push(receipt),
      log: () => {},
    })
    const event = metadataEvent()
    const before = JSON.stringify(event)

    // when
    const injected = await injector(event)

    // then
    expect(injected).toBe(false)
    expect(JSON.stringify(event)).toBe(before)
    expect(receipts).toHaveLength(0)
  })

  test("#when the parent transcript is huge #then injection respects the V1 message and byte caps", async () => {
    // given
    const receipts = []
    const injector = createBtwContextInjector({
      readSession: async () => ({ metadata: SIDE_METADATA }),
      readParentMessages: async () => parentMessages(200, "x".repeat(2000)),
      writeReceipt: (receipt) => receipts.push(receipt),
      log: () => {},
    })
    const event = metadataEvent()

    // when
    await injector(event)

    // then
    const injectedCount = event.messages.length - 1
    expect(injectedCount).toBeLessThanOrEqual(BTW_PARENT_CONTEXT_MAX_MESSAGES)
    expect(receipts[0].messages).toBe(injectedCount)
    expect(receipts[0].bytes).toBeLessThanOrEqual(BTW_PARENT_CONTEXT_MAX_BYTES)
  })

  test("#when a boundary is already present #then the second pass is a no-op (no stacking)", async () => {
    // given
    let receiptWrites = 0
    const injector = createBtwContextInjector({
      readSession: async () => ({ metadata: SIDE_METADATA }),
      readParentMessages: async () => parentMessages(2),
      writeReceipt: () => {
        receiptWrites += 1
      },
      log: () => {},
    })
    const event = metadataEvent()
    await injector(event)
    const afterFirst = JSON.stringify(event)

    // when
    const injected = await injector(event)

    // then
    expect(injected).toBe(false)
    expect(JSON.stringify(event)).toBe(afterFirst)
    expect(receiptWrites).toBe(1)
  })

  test("#when the parent read throws #then the boundary still lands and the turn is not broken", async () => {
    // given
    const receipts = []
    const injector = createBtwContextInjector({
      readSession: async () => ({ metadata: SIDE_METADATA }),
      readParentMessages: async () => {
        throw new Error("parent read boom")
      },
      writeReceipt: (receipt) => receipts.push(receipt),
      log: () => {},
    })
    const event = metadataEvent()

    // when
    const injected = await injector(event)

    // then
    expect(injected).toBe(true)
    expect(event.system[0].text).toContain(BTW_BOUNDARY_SENTINEL)
    expect(receipts[0].messages).toBe(0)
  })
})

describe("#given the context installer", () => {
  test("#when installed #then it registers the V2 context hook and the handler injects", async () => {
    // given
    const hooks = new Map()
    const receipts = []
    const context = {
      session: {
        hook: async (name, handler) => {
          hooks.set(name, handler)
          return () => hooks.delete(name)
        },
        get: async () => ({ metadata: SIDE_METADATA }),
        context: async () => parentMessages(2),
      },
    }
    const installer = createBtwContextInstaller({
      writeReceipt: (receipt) => receipts.push(receipt),
      log: () => {},
    })

    // when
    const dispose = await installer.install(context)
    const event = metadataEvent()
    await hooks.get("context")(event)

    // then
    expect(typeof dispose).toBe("function")
    expect(hooks.has("context")).toBe(true)
    expect(event.system[0].text).toContain(BTW_BOUNDARY_SENTINEL)
    expect(receipts).toHaveLength(1)
    expect(installer.id).toBe("oh-my-rigel.btw-context")
  })

  test("#when the host exposes no context hook #then install is a safe no-op", async () => {
    // given
    const installer = createBtwContextInstaller()

    // when / then
    expect(await installer.install({})).toBeUndefined()
    expect(await installer.install({ session: {} })).toBeUndefined()
  })

  test("#when the default export runs #then it carries the stable id", () => {
    expect(createBtwContextInstaller().id).toBe("oh-my-rigel.btw-context")
  })
})

describe("#given the injection receipt", () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rigel-btw-receipt-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("#then the path resolves under $XDG_STATE_HOME/oh-my-rigel", () => {
    const path = resolveBtwReceiptPath({ XDG_STATE_HOME: "/var/state" }, "/home/gabo")
    expect(path).toBe(join("/var/state", "oh-my-rigel", BTW_INJECTION_RECEIPT_FILE))
    expect(resolveBtwReceiptPath({}, "/home/gabo")).toBe(join("/home/gabo", ".local", "state", "oh-my-rigel", BTW_INJECTION_RECEIPT_FILE))
  })

  test("#when written #then the durable JSON carries the injection fields", () => {
    // given
    const path = join(dir, "nested", BTW_INJECTION_RECEIPT_FILE)

    // when
    const ok = writeBtwInjectionReceipt(path, { sessionID: "ses_side", injected: true, parentSessionID: "ses_main", messages: 4, bytes: 1234 }, () => {})

    // then
    expect(ok).toBe(true)
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    expect(parsed).toMatchObject({ sessionID: "ses_side", injected: true, parentSessionID: "ses_main", messages: 4, bytes: 1234 })
    expect(typeof parsed.recordedAt).toBe("string")
  })
})
