/**
 * Non-blocking FIFO handoff pump for Oh My Rigel's native OpenCode V2 runtime.
 *
 * The background manager must deliver a parent-wake handoff for each finished
 * background child, but the runtime observes those completions inside its single
 * `for await` event loop. Awaiting a handoff there stalled every later event, so
 * this pump separates "queue the work" from "do the work":
 *
 *   - `enqueue(item)` appends and returns synchronously. It never awaits, so the
 *     caller (the event loop) is never blocked, no matter how slow `run` is.
 *   - the pump drains the queue serially behind a microtask, preserving wake
 *     order, and each `run` may `await` real I/O on its own.
 *
 * There is NO `setInterval` / `setTimeout`: the only wake-up source is
 * `enqueue`, and the drain is a promise chain. `whenIdle()` is the deterministic
 * test/teardown seam.
 *
 * Per-item delivery attempts are bounded by `maxAttempts`; the pump tracks them
 * (never a timer) and calls `onExhausted` once the budget is spent, so a
 * permanently failing wake is reported and dropped instead of retried forever.
 */

/** Bounded delivery attempts for one handoff before it is reported exhausted. */
export const MAX_WAKE_ATTEMPTS = 3

/**
 * Create an independent pump.
 *
 * Callbacks:
 *  - `run(item)`                required async effect.
 *  - `onDelivered(item)`        called after `run` resolves.
 *  - `onFailed(item, error, n)` called after a failed attempt below the cap.
 *  - `onExhausted(item, error)` called after the final failed attempt.
 *  - `onError(error, item)`     observes a throwing callback (never stops the pump).
 */
export function createHandoffPump({
  run,
  onDelivered,
  onFailed,
  onExhausted,
  maxAttempts = MAX_WAKE_ATTEMPTS,
  onError,
} = {}) {
  const queue = []
  const attempts = new Map()
  const idleWaiters = []
  let pumping = false
  let disposed = false

  function safe(callback, ...args) {
    if (typeof callback !== "function") return
    try {
      callback(...args)
    } catch (error) {
      if (typeof onError === "function") onError(error, args[0])
    }
  }

  function settleIdle() {
    if (pumping || queue.length > 0) return
    const waiters = idleWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  function kick() {
    if (pumping || disposed) return
    pumping = true
    Promise.resolve().then(pump)
  }

  async function pump() {
    try {
      while (!disposed && queue.length > 0) {
        const item = queue.shift()
        const attempt = (attempts.get(item.sessionID) ?? 0) + 1
        attempts.set(item.sessionID, attempt)
        try {
          if (typeof run === "function") await run(item)
          attempts.delete(item.sessionID)
          safe(onDelivered, item)
        } catch (error) {
          if (attempt >= maxAttempts) {
            attempts.delete(item.sessionID)
            safe(onExhausted, item, error)
          } else {
            safe(onFailed, item, error, attempt)
          }
        }
      }
    } finally {
      pumping = false
      if (!disposed && queue.length > 0) kick()
      settleIdle()
    }
  }

  function enqueue(item) {
    if (disposed || !item) return false
    queue.push(item)
    kick()
    return true
  }

  function has(sessionID) {
    return queue.some((item) => item.sessionID === sessionID)
  }

  function remove(sessionID) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].sessionID === sessionID) queue.splice(index, 1)
    }
    attempts.delete(sessionID)
  }

  function pending() {
    return queue.length > 0
  }

  function whenIdle() {
    if (!pumping && queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  function clear() {
    queue.length = 0
    attempts.clear()
    settleIdle()
  }

  function dispose() {
    disposed = true
    clear()
  }

  return { enqueue, has, remove, pending, whenIdle, clear, dispose }
}
