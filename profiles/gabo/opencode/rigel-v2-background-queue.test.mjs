import { describe, expect, test } from "bun:test"
import { ConcurrencyManager } from "../../../packages/omo-opencode/src/features/background-agent/concurrency.ts"
import { createBackgroundQueue } from "./rigel-v2-background-queue.mjs"

// The native V2 runtime cannot import `packages/` TypeScript, so the queue is a
// plain-JS state machine ported from the real owner:
//   packages/omo-opencode/src/features/background-agent/concurrency.ts
//     acquire (55-85), release (87-109), cancelWaiter (111-131)
// The parity block imports the real ConcurrencyManager and pins agreement on the
// hand-off counter, the cancel message, and the key-tagged getters, so upstream
// drift in the queue semantics fails this suite.

const CANCELLED = (taskId) => `Concurrency queue cancelled for task: ${taskId}`

describe("#given a per-key FIFO queue at limit 1", () => {
  describe("#when three tasks are enqueued against one key", () => {
    test("#then the first is admitted and the rest queue in FIFO order", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")

      // when
      const first = queue.enqueue("m", "t1")
      const second = queue.enqueue("m", "t2")
      const third = queue.enqueue("m", "t3")

      // then
      expect(first).toEqual({ admitted: true, queued: false, key: "m", limit: 1 })
      expect(second).toEqual({ admitted: false, queued: true, key: "m", limit: 1 })
      expect(third).toEqual({ admitted: false, queued: true, key: "m", limit: 1 })
      expect(queue.getCount(key)).toBe(1)
      expect(queue.getQueueLength(key)).toBe(2)
    })
  })

  describe("#when slots are released in sequence", () => {
    test("#then the FIFO hand-off grants t2 then t3 and keeps the count saturated", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")
      queue.enqueue("m", "t3")

      // when
      const handoff1 = queue.release(key)
      const handoff2 = queue.release(key)
      const handoff3 = queue.release(key)

      // then: the count stays at 1 across both hand-offs, then drops to 0
      expect(handoff1).toEqual({ granted: { taskId: "t2" }, count: 1 })
      expect(handoff2).toEqual({ granted: { taskId: "t3" }, count: 1 })
      expect(handoff3).toEqual({ granted: null, count: 0 })
    })
  })
})

describe("#given a queue saturated at limit 2", () => {
  describe("#when a third task arrives", () => {
    test("#then it queues until a release hands off the slot without changing the count", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 2 })
      const key = queue.getKeyForModel("m")

      // when
      const a = queue.enqueue("m", "a")
      const b = queue.enqueue("m", "b")
      const c = queue.enqueue("m", "c")

      // then
      expect([a.admitted, b.admitted, c.admitted]).toEqual([true, true, false])
      expect(queue.getCount(key)).toBe(2)
      expect(queue.getQueueLength(key)).toBe(1)

      // when the slot frees
      const handoff = queue.release(key)

      // then
      expect(handoff).toEqual({ granted: { taskId: "c" }, count: 2 })
      expect(queue.getQueueLength(key)).toBe(0)
    })
  })
})

describe("#given a 0 limit (Infinity)", () => {
  describe("#when many tasks are enqueued", () => {
    test("#then every task is admitted, no counter is kept, and release stays at 0", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 0 })
      const key = queue.getKeyForModel("m")

      // when
      const first = queue.enqueue("m", "t1")
      const second = queue.enqueue("m", "t2")
      const release = queue.release(key)

      // then
      expect(first).toEqual({ admitted: true, queued: false, key: "m", limit: Infinity })
      expect(second).toEqual({ admitted: true, queued: false, key: "m", limit: Infinity })
      expect(queue.getCount(key)).toBe(0)
      expect(release).toEqual({ granted: null, count: 0 })
    })
  })
})

describe("#given a queued task", () => {
  describe("#when cancelWaiter targets it", () => {
    test("#then it is rejected with the exact V1 message and removed from the queue", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")

      // when
      const result = queue.cancelWaiter(key, "t2")

      // then
      expect(result.cancelled).toBe(true)
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe(CANCELLED("t2"))
      expect(queue.getQueueLength(key)).toBe(0)
    })
  })

  describe("#when cancelWaiter targets a task in the middle of the queue", () => {
    test("#then only the matching waiter is spliced and FIFO order is preserved", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")
      queue.enqueue("m", "t3")
      queue.enqueue("m", "t4")

      // when
      const result = queue.cancelWaiter(key, "t3")

      // then
      expect(result.cancelled).toBe(true)
      expect(queue.getQueueLength(key)).toBe(2)
      expect(queue.release(key)).toEqual({ granted: { taskId: "t2" }, count: 1 })
      expect(queue.release(key)).toEqual({ granted: { taskId: "t4" }, count: 1 })
    })
  })

  describe("#when cancelWaiter targets a task that is not queued", () => {
    test("#then it returns false, produces no error, and leaves the queue intact", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")

      // when
      const missing = queue.cancelWaiter(key, "nope")

      // then
      expect(missing).toEqual({ cancelled: false, error: null })
      expect(queue.getQueueLength(key)).toBe(1)
    })
  })

  describe("#when cancelWaiter targets a waiter already handed a slot", () => {
    test("#then it returns false because the waiter is settled", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")
      queue.release(key)

      // when
      const result = queue.cancelWaiter(key, "t2")

      // then
      expect(result).toEqual({ cancelled: false, error: null })
    })
  })
})

describe("#given provider and model concurrency config", () => {
  describe("#when two models share a provider bucket", () => {
    test("#then they collapse onto one key and one counter", () => {
      // given
      const queue = createBackgroundQueue({ providerConcurrency: { anthropic: 2 } })

      // when
      const first = queue.enqueue("anthropic/a", "t1")
      const second = queue.enqueue("anthropic/b", "t2")
      const third = queue.enqueue("anthropic/c", "t3")

      // then
      expect(first.key).toBe("anthropic")
      expect(second.key).toBe("anthropic")
      expect(third.key).toBe("anthropic")
      expect([first.admitted, second.admitted, third.admitted]).toEqual([true, true, false])
      expect(queue.getCount("anthropic")).toBe(2)
    })
  })

  describe("#when a model limit is configured alongside a provider limit", () => {
    test("#then the exact model keeps its own bucket and the sibling uses the provider bucket", () => {
      // given
      const queue = createBackgroundQueue({
        modelConcurrency: { "anthropic/a": 1 },
        providerConcurrency: { anthropic: 5 },
      })

      // when
      const modelKey = queue.getKeyForModel("anthropic/a")
      const providerKey = queue.getKeyForModel("anthropic/b")

      // then
      expect(modelKey).toBe("anthropic/a")
      expect(providerKey).toBe("anthropic")
      expect(queue.getLimitForModel("anthropic/a")).toBe(1)
      expect(queue.getLimitForModel("anthropic/b")).toBe(5)
    })
  })
})

describe("#given explicit dequeue and drain", () => {
  describe("#when a queued waiter is dequeued", () => {
    test("#then it is removed FIFO and release skips it for the next waiter", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")
      queue.enqueue("m", "t3")

      // when
      const removed = queue.dequeue(key)

      // then
      expect(removed).toEqual({ taskId: "t2" })
      expect(queue.getQueueLength(key)).toBe(1)
      expect(queue.release(key)).toEqual({ granted: { taskId: "t3" }, count: 1 })
    })
  })

  describe("#when the queue is drained", () => {
    test("#then every waiter is returned in FIFO order and the queue empties", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")
      queue.enqueue("m", "t3")

      // when
      const drained = queue.drain(key)

      // then
      expect(drained).toEqual([{ taskId: "t2" }, { taskId: "t3" }])
      expect(queue.getQueueLength(key)).toBe(0)
      expect(queue.dequeue(key)).toBeNull()
    })
  })
})

describe("#given queue introspection", () => {
  describe("#when keys and clear are used", () => {
    test("#then only keyed buckets are listed and clear drops all state", () => {
      // given
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")

      // when / then
      expect(queue.keys()).toEqual(["m"])
      expect(queue.getCount("unknown")).toBe(0)
      expect(queue.getQueueLength("unknown")).toBe(0)

      // when
      queue.clear()

      // then
      expect(queue.keys()).toEqual([])
      expect(queue.getCount("m")).toBe(0)
      expect(queue.getQueueLength("m")).toBe(0)
    })
  })
})

describe("#given the real V1 ConcurrencyManager", () => {
  describe("#when a queued waiter is cancelled", () => {
    test("#then the rejection message is byte-identical to the V2 queue error", async () => {
      // given
      const manager = new ConcurrencyManager({ defaultConcurrency: 1 })
      await manager.acquire("m", "t1")
      const pending = manager.acquire("m", "t2")
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")

      // when
      const v1Cancelled = manager.cancelWaiter("m", "t2")
      const v2 = queue.cancelWaiter(key, "t2")

      // then
      expect(v1Cancelled).toBe(true)
      let v1Message
      await pending.catch((error) => {
        v1Message = error.message
      })
      expect(v1Message).toBe(CANCELLED("t2"))
      expect(v2.error.message).toBe(v1Message)
    })
  })

  describe("#when a slot is handed off", () => {
    test("#then the V1 count and the V2 count both stay at the limit", async () => {
      // given
      const manager = new ConcurrencyManager({ defaultConcurrency: 1 })
      await manager.acquire("m", "t1")
      const pending = manager.acquire("m", "t2")
      const queue = createBackgroundQueue({ defaultConcurrency: 1 })
      const key = queue.getKeyForModel("m")
      queue.enqueue("m", "t1")
      queue.enqueue("m", "t2")

      // when
      manager.release("m")
      const v2 = queue.release(key)
      await pending

      // then
      expect(manager.getCount("m")).toBe(1)
      expect(manager.getQueueLength("m")).toBe(0)
      expect(v2).toEqual({ granted: { taskId: "t2" }, count: 1 })
    })
  })

  describe("#when the limit is Infinity", () => {
    test("#then V1 resolves immediately and both counters stay at 0", async () => {
      // given
      const manager = new ConcurrencyManager({ defaultConcurrency: 0 })
      const queue = createBackgroundQueue({ defaultConcurrency: 0 })
      const key = queue.getKeyForModel("m")

      // when
      await manager.acquire("m", "t1")
      const admitted = queue.enqueue("m", "t1")

      // then
      expect(manager.getCount("m")).toBe(0)
      expect(admitted.admitted).toBe(true)
      expect(queue.getCount(key)).toBe(0)
    })
  })
})
