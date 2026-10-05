import { describe, expect, test } from "bun:test"
import { createSessionStateRegistry } from "./rigel-v2-native-session-state.mjs"

// The registry is the DEC-8 replacement for the hand-maintained `session.deleted`
// cleanup list in `rigel-v2-native.mjs` (which omitted `backgroundChildren` and
// `childSessionIDs`). These tests pin the fan-out contract: every disposer runs,
// one throwing disposer never stops its siblings, repeated disposal is
// idempotent, and clearAll covers every tracked session and store.

function createRecordingRegistry() {
  const errors = []
  const registry = createSessionStateRegistry({
    onError: (error, context) => errors.push({ error, context }),
  })
  return { registry, errors }
}

describe("disposeSession fan-out", () => {
  test("runs every disposer registered for the session", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const calls = []
    registry.register("session-a", () => calls.push("first"))
    registry.register("session-a", () => calls.push("second"))
    registry.register("session-a", () => calls.push("third"))

    // when
    await registry.disposeSession("session-a")

    // then
    expect(calls).toEqual(["first", "second", "third"])
  })

  test("passes the session id to each disposer", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const seen = []
    registry.register("session-a", (sessionID) => seen.push(sessionID))

    // when
    await registry.disposeSession("session-a")

    // then
    expect(seen).toEqual(["session-a"])
  })

  test("does not run another session's disposers", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const calls = []
    registry.register("session-a", () => calls.push("a"))
    registry.register("session-b", () => calls.push("b"))

    // when
    await registry.disposeSession("session-a")

    // then
    expect(calls).toEqual(["a"])
  })

  test("awaits an async disposer before running the next", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const order = []
    registry.register("session-a", async () => {
      await Promise.resolve()
      order.push("async")
    })
    registry.register("session-a", () => order.push("after"))

    // when
    await registry.disposeSession("session-a")

    // then
    expect(order).toEqual(["async", "after"])
  })
})

describe("disposer isolation", () => {
  test("a throwing disposer does not stop its siblings", async () => {
    // given
    const { registry, errors } = createRecordingRegistry()
    const calls = []
    registry.register("session-a", () => calls.push("before"))
    registry.register("session-a", () => {
      throw new Error("boom")
    })
    registry.register("session-a", () => calls.push("middle"))
    registry.register("session-a", async () => {
      throw new Error("async boom")
    })
    registry.register("session-a", () => calls.push("after"))

    // when
    await registry.disposeSession("session-a")

    // then: both throwers were reported and every non-throwing sibling still ran
    expect(calls).toEqual(["before", "middle", "after"])
    expect(errors).toHaveLength(2)
    expect(errors.map((entry) => entry.context.source)).toEqual(["disposer", "disposer"])
    expect(errors.every((entry) => entry.context.sessionID === "session-a")).toBe(true)
  })

  test("a throwing store clear does not stop the session disposers", async () => {
    // given
    const { registry, errors } = createRecordingRegistry()
    const calls = []
    registry.registerStore({
      clear: () => {
        throw new Error("store boom")
      },
    })
    registry.register("session-a", () => calls.push("disposer"))

    // when
    await registry.disposeSession("session-a")

    // then
    expect(calls).toEqual(["disposer"])
    expect(errors).toHaveLength(1)
    expect(errors[0].context.source).toBe("store")
  })

  test("ignores invalid registrations without throwing", () => {
    // given
    const { registry } = createRecordingRegistry()

    // when / then: dumb registry never fails the caller's write path
    expect(() => registry.register("", () => {})).not.toThrow()
    expect(() => registry.register("session-a", undefined)).not.toThrow()
    expect(() => registry.register(undefined, () => {})).not.toThrow()
    expect(() => registry.registerStore(undefined)).not.toThrow()
    expect(() => registry.registerStore({})).not.toThrow()
  })
})

describe("idempotent disposal", () => {
  test("a repeated disposeSession runs each disposer once", async () => {
    // given
    const { registry } = createRecordingRegistry()
    let count = 0
    registry.register("session-a", () => {
      count += 1
    })

    // when
    await registry.disposeSession("session-a")
    await registry.disposeSession("session-a")
    await registry.disposeSession("session-a")

    // then
    expect(count).toBe(1)
  })

  test("a store's per-session clear is also idempotent across repeats", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const cleared = []
    registry.registerStore({ clear: (sessionID) => cleared.push(sessionID) })

    // when
    await registry.disposeSession("session-a")
    await registry.disposeSession("session-a")

    // then
    expect(cleared).toEqual(["session-a"])
  })

  test("re-registering after disposal re-arms the session", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const calls = []
    registry.register("session-a", () => calls.push("first"))
    await registry.disposeSession("session-a")

    // when
    registry.register("session-a", () => calls.push("second"))
    await registry.disposeSession("session-a")

    // then
    expect(calls).toEqual(["first", "second"])
  })
})

describe("clearAll", () => {
  test("disposes every tracked session", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const calls = []
    registry.register("session-a", () => calls.push("a1"))
    registry.register("session-a", () => calls.push("a2"))
    registry.register("session-b", () => calls.push("b1"))

    // when
    await registry.clearAll()

    // then
    expect(calls).toEqual(["a1", "a2", "b1"])
  })

  test("calls a registered store's clearAll once", async () => {
    // given
    const { registry } = createRecordingRegistry()
    let clearAllCalls = 0
    const perSession = []
    registry.registerStore({
      clear: (sessionID) => perSession.push(sessionID),
      clearAll: () => {
        clearAllCalls += 1
      },
    })
    registry.register("session-a", () => {})

    // when
    await registry.clearAll()

    // then
    expect(clearAllCalls).toBe(1)
    expect(perSession).toEqual([])
  })

  test("falls back to per-session clear for a store without clearAll", async () => {
    // given
    const { registry } = createRecordingRegistry()
    const perSession = []
    registry.registerStore({ clear: (sessionID) => perSession.push(sessionID) })
    registry.register("session-a", () => {})
    registry.register("session-b", () => {})

    // when
    await registry.clearAll()

    // then
    expect(perSession).toEqual(["session-a", "session-b"])
  })

  test("clears a clear-only store for a session known only through disposeSession", async () => {
    // given: the session was deleted (so it never used the explicit-disposer API),
    // and its store is registered after that delete.
    const { registry } = createRecordingRegistry()
    await registry.disposeSession("session-a")
    const cleared = []
    registry.registerStore({ clear: (sessionID) => cleared.push(sessionID) })

    // when
    await registry.clearAll()

    // then: clearAll covers every session the registry saw, not only the
    // (runtime-empty) explicit-disposer map
    expect(cleared).toEqual(["session-a"])
  })

  test("a throwing disposer does not stop the rest of clearAll", async () => {
    // given
    const { registry, errors } = createRecordingRegistry()
    const calls = []
    registry.register("session-a", () => {
      throw new Error("boom")
    })
    registry.register("session-b", () => calls.push("b"))

    // when
    await registry.clearAll()

    // then
    expect(calls).toEqual(["b"])
    expect(errors).toHaveLength(1)
  })

  test("is a no-op on a fresh registry and after a first clearAll", async () => {
    // given
    const { registry } = createRecordingRegistry()
    let count = 0
    registry.register("session-a", () => {
      count += 1
    })

    // when
    await registry.clearAll()
    await registry.clearAll()

    // then
    expect(count).toBe(1)
  })
})
