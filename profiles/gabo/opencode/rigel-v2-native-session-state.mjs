/**
 * Per-session dispose fan-out registry for Oh My Rigel's native OpenCode V2
 * runtime.
 *
 * The runtime keeps several session-scoped stores (reminders, rules, the write
 * guard, the comment checker, the web-fetch guard) plus raw collections
 * (`backgroundChildren`, `childSessionIDs`). Each store advertises its own
 * `clear(sessionID)`, but the `session.deleted` handler in
 * `rigel-v2-native.mjs` hand-lists them, and that hand-maintained list omitted
 * `backgroundChildren` and `childSessionIDs`. This registry replaces the list
 * with a fan-out keyed by session: a disposer is registered where the
 * session-scoped state is created, so a cleanup site cannot be forgotten.
 *
 * Deliberately dumb and NOT a generic state service. It stores closures, runs
 * them all for a session, and never inspects or interprets what they do. Every
 * disposer runs in isolation: one throwing disposer is reported but never stops
 * its siblings, so a single buggy cleanup cannot abort the rest of a session
 * teardown.
 *
 * Pure module: no imports, no runtime dependencies, no I/O.
 */

/**
 * Upper bound on the idempotency history. A long-lived plugin would otherwise
 * grow `disposedSessions` once per deleted session forever. Eviction is FIFO
 * (Set preserves insertion order), so only the oldest marks are dropped.
 */
const DISPOSED_SESSIONS_LIMIT = 4096

function defaultOnError(error, context) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[oh-my-rigel] Native V2 session dispose failed: session=${context?.sessionID ?? "unknown"}; source=${context?.source ?? "unknown"}; ${message}`)
}

/**
 * Create an independent registry. Returns:
 *
 * - `register(sessionID, dispose)` adds one disposer for a session. The
 *   disposer is invoked as `dispose(sessionID)`, so a store's own
 *   `clear` method can be passed directly. Invalid input is ignored rather
 *   than thrown: the registry is dumb and never fails a caller's write path.
 *
 * - `registerStore(store)` registers a per-session store whose `clear(sessionID)`
 *   is fanned out for every disposed session. When the store also exposes
 *   `clearAll()`, `clearAll()` prefers it; otherwise the store's `clear` is
 *   invoked once per tracked session.
 *
 * - `disposeSession(sessionID)` runs every disposer registered for that session
 *   (registered disposers first, then registered stores' `clear`). Idempotent:
 *   a second call for the same session is a no-op.
 *
 * - `clearAll()` disposes every tracked session and clears all store state.
 *
 * `onError` is an optional reporter `(error, { sessionID, source })`; the
 * default logs to `console.error`. It is only ever called from inside the
 * isolation guard, so it cannot interrupt a fan-out.
 */
export function createSessionStateRegistry({ onError } = {}) {
  const reportError = typeof onError === "function" ? onError : defaultOnError
  const disposersBySession = new Map()
  const knownSessions = new Set()
  const stores = []
  const disposedSessions = new Set()

  async function runIsolated(dispose, context) {
    try {
      await dispose(context.sessionID)
    } catch (error) {
      reportError(error, context)
    }
  }

  function register(sessionID, dispose) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (typeof dispose !== "function") return
    knownSessions.add(sessionID)
    const existing = disposersBySession.get(sessionID)
    if (existing) {
      existing.push(dispose)
    } else {
      disposersBySession.set(sessionID, [dispose])
    }
    // A fresh registration means the session has new state to dispose, so
    // re-arm an idempotency mark left by an earlier disposal.
    disposedSessions.delete(sessionID)
  }

  function registerStore(store) {
    if (!store || typeof store.clear !== "function") return
    stores.push(store)
  }

  async function disposeSession(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (disposedSessions.has(sessionID)) return
    knownSessions.add(sessionID)
    disposedSessions.add(sessionID)
    if (disposedSessions.size > DISPOSED_SESSIONS_LIMIT) {
      const oldest = disposedSessions.values().next().value
      if (oldest !== undefined) disposedSessions.delete(oldest)
    }
    const disposers = disposersBySession.get(sessionID)
    disposersBySession.delete(sessionID)
    if (disposers) {
      for (const dispose of disposers) {
        await runIsolated(dispose, { sessionID, source: "disposer" })
      }
    }
    for (const store of stores) {
      await runIsolated(() => store.clear(sessionID), { sessionID, source: "store" })
    }
  }

  async function clearAll() {
    // A store registered with only `clear` (no `clearAll`) is cleared once per
    // session the registry has ever seen. Sessions reach the registry through
    // `register` (explicit disposers) or `disposeSession` (session.deleted); a
    // clear-only store must be cleared for both sets, not just the (usually
    // empty) explicit-disposer map.
    const sessionIDs = new Set([...disposersBySession.keys(), ...knownSessions])
    for (const sessionID of sessionIDs) {
      const disposers = disposersBySession.get(sessionID)
      if (!disposers) continue
      disposersBySession.delete(sessionID)
      for (const dispose of disposers) {
        await runIsolated(dispose, { sessionID, source: "disposer" })
      }
    }
    for (const store of stores) {
      if (typeof store.clearAll === "function") {
        await runIsolated(() => store.clearAll(), { sessionID: "", source: "store" })
      } else {
        for (const sessionID of sessionIDs) {
          await runIsolated(() => store.clear(sessionID), { sessionID, source: "store" })
        }
      }
    }
    disposersBySession.clear()
    knownSessions.clear()
    disposedSessions.clear()
  }

  return { register, registerStore, disposeSession, clearAll }
}
