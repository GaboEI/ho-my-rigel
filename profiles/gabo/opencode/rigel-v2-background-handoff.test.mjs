import { describe, expect, test } from "bun:test"
import { MAX_WAKE_ATTEMPTS, createHandoffPump } from "./rigel-v2-background-handoff.mjs"

// The pump is the non-blocking FIFO handoff owner. These tests drive it at its
// own boundary (`run` / `onDelivered` / `onFailed` / `onExhausted` / `onError` /
// `whenIdle`). Retries are modeled the way the manager drives them: an item below
// the cap is re-enqueued by the caller, so the per-sessionID attempt counter in
// the pump advances across enqueues.

describe("createHandoffPump retry callbacks", () => {
  test("calls onFailed with attempt 1 then delivers on the retry", async () => {
    // given: run rejects once, then succeeds; the caller re-enqueues on failure
    const item = { sessionID: "retry-then-deliver" }
    const failure = new Error("transient")
    const failed = []
    const delivered = []
    const exhausted = []
    let runs = 0
    let pump
    pump = createHandoffPump({
      run: async () => {
        runs += 1
        if (runs === 1) throw failure
      },
      onFailed: (failedItem, error, attempt) => {
        failed.push([failedItem, error, attempt])
        pump.enqueue(item)
      },
      onDelivered: (deliveredItem) => delivered.push(deliveredItem),
      onExhausted: (exhaustedItem, error) => exhausted.push([exhaustedItem, error]),
    })

    // when
    pump.enqueue(item)
    await pump.whenIdle()

    // then
    expect(failed).toHaveLength(1)
    expect(failed[0][0]).toBe(item)
    expect(failed[0][1]).toBe(failure)
    expect(failed[0][2]).toBe(1)
    expect(delivered).toEqual([item])
    expect(exhausted).toHaveLength(0)
    expect(pump.pending()).toBe(false)
  })

  test("calls onExhausted once on attempt 3 and drops the item", async () => {
    // given: run always rejects; the caller re-enqueues only below the cap
    const item = { sessionID: "always-fails" }
    const failure = new Error("permanent")
    const failedAttempts = []
    const exhausted = []
    let pump
    pump = createHandoffPump({
      run: async () => {
        throw failure
      },
      onFailed: (_item, _error, attempt) => {
        failedAttempts.push(attempt)
        pump.enqueue(item)
      },
      onExhausted: (exhaustedItem, error) => exhausted.push([exhaustedItem, error]),
    })

    // when
    pump.enqueue(item)
    await pump.whenIdle()

    // then
    expect(MAX_WAKE_ATTEMPTS).toBe(3)
    expect(failedAttempts).toEqual([1, 2])
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0][0]).toBe(item)
    expect(exhausted[0][1]).toBe(failure)
    expect(pump.pending()).toBe(false)
  })
})

describe("createHandoffPump callback-error isolation", () => {
  test("routes a throwing onDelivered to onError and drains the rest", async () => {
    // given: the first delivery callback throws, the second succeeds
    const itemA = { sessionID: "throwing-deliver-a" }
    const itemB = { sessionID: "throwing-deliver-b" }
    const boom = new Error("onDelivered threw")
    const errors = []
    const delivered = []
    const pump = createHandoffPump({
      run: async () => {},
      onDelivered: (item) => {
        delivered.push(item)
        if (item === itemA) throw boom
      },
      onError: (error, item) => errors.push([error, item]),
    })

    // when
    pump.enqueue(itemA)
    pump.enqueue(itemB)
    await pump.whenIdle()

    // then
    expect(delivered).toEqual([itemA, itemB])
    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe(boom)
    expect(errors[0][1]).toBe(itemA)
    expect(pump.pending()).toBe(false)
  })

  test("routes a throwing onFailed to onError and drains the rest", async () => {
    // given: item A rejects below the cap and its onFailed throws; B succeeds
    const itemA = { sessionID: "throwing-failed-a" }
    const itemB = { sessionID: "throwing-failed-b" }
    const runError = new Error("run rejected")
    const callbackError = new Error("onFailed threw")
    const errors = []
    const delivered = []
    const pump = createHandoffPump({
      run: async (item) => {
        if (item === itemA) throw runError
      },
      onFailed: (item) => {
        if (item === itemA) throw callbackError
      },
      onDelivered: (item) => delivered.push(item),
      onError: (error, item) => errors.push([error, item]),
    })

    // when
    pump.enqueue(itemA)
    pump.enqueue(itemB)
    await pump.whenIdle()

    // then
    expect(delivered).toEqual([itemB])
    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe(callbackError)
    expect(errors[0][1]).toBe(itemA)
    expect(pump.pending()).toBe(false)
  })
})

describe("createHandoffPump ordering and non-blocking enqueue", () => {
  test("preserves FIFO order and returns synchronously before the drain", async () => {
    // given: an async run that yields the microtask queue
    const order = []
    const pump = createHandoffPump({
      run: async (item) => {
        await Promise.resolve()
        order.push(item.sessionID)
      },
      onDelivered: () => {},
    })

    // when: enqueue several items back to back
    const first = pump.enqueue({ sessionID: "order-a" })
    const second = pump.enqueue({ sessionID: "order-b" })
    const third = pump.enqueue({ sessionID: "order-c" })
    const drainedSynchronously = order.length

    // then: enqueue returned true before any run executed
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(third).toBe(true)
    expect(drainedSynchronously).toBe(0)

    // when: the pump drains
    await pump.whenIdle()

    // then: delivery order is preserved
    expect(order).toEqual(["order-a", "order-b", "order-c"])
    expect(pump.pending()).toBe(false)
  })
})
