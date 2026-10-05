/**
 * Background-agent FIFO admission queue for Oh My Rigel's native OpenCode V2
 * runtime.
 *
 * Plain-JS port of the matching OmO revision:
 *   packages/omo-opencode/src/features/background-agent/concurrency.ts
 *     acquire      (55-85):  limit Infinity -> immediate; count < limit -> count++; else push waiter
 *     release      (87-109): hand off to the next unsettled waiter (count stays) or decrement
 *     cancelWaiter (111-131): settle + splice ONLY the matching waiter, reject with the exact message
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so the queue
 * lives here as a pure state machine. It carries NO promises, timers, poller, or
 * I/O: `enqueue` reports whether a task was admitted or queued, and `release`
 * reports which waiter (by taskId) received the freed slot. The caller drives
 * the wake-up, so the single-threaded V2 event loop never stalls on a pending
 * promise and no interval is needed.
 *
 * Key and limit derivation is delegated to `resolveAdmissionKey` /
 * `resolveAdmissionLimit` (T2, `rigel-v2-background-key.mjs`), which mirror V1
 * `ConcurrencyManager.getConcurrencyKey` / `getConcurrencyLimit`
 * (model -> provider -> default -> 5, with 0 meaning Infinity at every tier).
 *
 * Waiter lifecycle, mirroring V1:
 *   - a waiter is `settled: false` while queued;
 *   - `release` settles the waiter it hands the slot to and keeps the count;
 *   - `cancelWaiter` settles ONLY the matching waiter, rejects it with the
 *     exact V1 message, and splices it without disturbing the others;
 *   - `dequeue`/`drain` remove queued waiters without granting a slot.
 */

import { resolveAdmissionKey, resolveAdmissionLimit } from "./rigel-v2-background-key.mjs"

/**
 * Create an independent FIFO queue. `config` is the background-task
 * concurrency config (`{ modelConcurrency, providerConcurrency,
 * defaultConcurrency }`), passed straight to the key/limit derivation.
 *
 * Every method that looks up a bucket takes the resolved KEY, not the model:
 * `enqueue` returns the key, and later calls pass that same key, so a provider
 * that several models collapse onto shares one FIFO and one counter.
 */
export function createBackgroundQueue(config) {
  const counts = new Map()
  const queues = new Map()

  function keyFor(model) {
    return resolveAdmissionKey(model, config)
  }

  function limitFor(model) {
    return resolveAdmissionLimit(model, config)
  }

  /**
   * Admit immediately when the bucket is below its limit, otherwise queue the
   * task FIFO. A limit of Infinity admits without touching the counter, exactly
   * like V1's `acquire` early return.
   */
  function enqueue(model, taskId) {
    const key = keyFor(model)
    const limit = limitFor(model)
    if (limit === Infinity) {
      return { admitted: true, queued: false, key, limit }
    }
    const current = counts.get(key) ?? 0
    if (current < limit) {
      counts.set(key, current + 1)
      return { admitted: true, queued: false, key, limit }
    }
    const queue = queues.get(key) ?? []
    queue.push({ taskId, settled: false })
    queues.set(key, queue)
    return { admitted: false, queued: true, key, limit }
  }

  /**
   * Free a slot for `key`. V1 order: hand the slot to the next unsettled waiter
   * (the counter stays the same, so the concurrency stays saturated), otherwise
   * decrement the counter. Settled waiters left by `cancelWaiter` are discarded
   * on the way. Returns the granted waiter, if any, and the current count.
   */
  function release(key) {
    const queue = queues.get(key)
    while (queue && queue.length > 0) {
      const next = queue.shift()
      if (!next) continue
      if (!next.settled) {
        next.settled = true
        return { granted: { taskId: next.taskId }, count: counts.get(key) ?? 0 }
      }
    }
    if (queue) queues.delete(key)
    const current = counts.get(key) ?? 0
    if (current > 0) {
      counts.set(key, current - 1)
    }
    return { granted: null, count: counts.get(key) ?? 0 }
  }

  /**
   * Remove and return the next queued waiter (FIFO, skipping settled entries),
   * marking it settled. Does NOT grant a slot or change the counter. Returns
   * `{ taskId }` or null when the bucket has no queued waiter.
   */
  function dequeue(key) {
    const queue = queues.get(key)
    while (queue && queue.length > 0) {
      const next = queue.shift()
      if (!next) continue
      if (!next.settled) {
        next.settled = true
        if (queue.length === 0) queues.delete(key)
        return { taskId: next.taskId }
      }
    }
    if (queue) queues.delete(key)
    return null
  }

  /**
   * Remove and return every queued waiter for `key`, in FIFO order. Does NOT
   * grant slots or change the counter.
   */
  function drain(key) {
    const drained = []
    let next = dequeue(key)
    while (next) {
      drained.push(next)
      next = dequeue(key)
    }
    return drained
  }

  /**
   * Cancel a specific queued task. V1 semantics: find the first unsettled
   * waiter whose taskId matches, mark it settled, build the exact V1 error,
   * splice ONLY that entry, and drop the bucket when it empties. Returns
   * `{ cancelled, error }`; `error` is null when nothing matched.
   */
  function cancelWaiter(key, taskId) {
    const queue = queues.get(key)
    if (!queue) return { cancelled: false, error: null }
    const index = queue.findIndex((entry) => entry.taskId === taskId && !entry.settled)
    if (index === -1) return { cancelled: false, error: null }
    const entry = queue[index]
    entry.settled = true
    const error = new Error(`Concurrency queue cancelled for task: ${taskId}`)
    queue.splice(index, 1)
    if (queue.length === 0) {
      queues.delete(key)
    }
    return { cancelled: true, error }
  }

  function getCount(key) {
    return counts.get(key) ?? 0
  }

  function getQueueLength(key) {
    return queues.get(key)?.length ?? 0
  }

  function getKeyForModel(model) {
    return keyFor(model)
  }

  function getLimitForModel(model) {
    return limitFor(model)
  }

  function keys() {
    return [...queues.keys()]
  }

  function clear() {
    counts.clear()
    queues.clear()
  }

  return {
    enqueue,
    release,
    dequeue,
    drain,
    cancelWaiter,
    getCount,
    getQueueLength,
    getKeyForModel,
    getLimitForModel,
    keys,
    clear,
  }
}
