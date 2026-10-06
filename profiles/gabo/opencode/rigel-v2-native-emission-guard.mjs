/**
 * Shared emission guard for the companion CLI plugin.
 *
 * The TUI can host more than one CLI-plugin instance (reconciliation and
 * reconnects observed in the laboratory), and an event stream can re-deliver
 * the same input-needed event. The plugin's per-instance `seenRequests` set
 * cannot collapse a duplicate that lands in a different instance, so a duplicate
 * toast/system notification is possible.
 *
 * This guard is the shared, file-backed idempotence gate. The claim is a real
 * atomic create (`open(..., "wx")` = O_CREAT|O_EXCL), not an `existsSync` plus
 * write race: two processes that observe absence both call the exclusive create
 * and exactly one wins; the loser gets EEXIST, sees a fresh record and returns
 * false. An expired record is reclaimed under a short-lived exclusive lock file
 * (with stale-lock takeover) so an expired key still yields exactly one winner,
 * and the lock is always removed. A record that exists but cannot be read is
 * treated as fresh until its mtime passes the TTL, so a partial write never lets
 * a second claimer through.
 *
 * Lives under the same shared XDG state root as the todo bridge, so all
 * instances of the plugin agree without a socket or a server round trip.
 */

import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"

export const EMISSION_GUARD_DIR = "oh-my-rigel/emitted"

/** A stale lock (holder died) is stolen after this window. */
export const DEFAULT_LOCK_TTL_MS = 2000

export function emissionGuardKey(kind, sessionID, requestID) {
  return `${kind}:${sessionID}:${requestID ?? "none"}`
}

/**
 * Deterministic, escape-proof filename for a key. Hashing removes any path
 * separator or traversal the key could carry, so a crafted session/request id
 * can never write outside the guard directory.
 */
export function emissionGuardPath(stateRoot, key) {
  const name = createHash("sha1").update(key).digest("hex")
  return join(stateRoot, EMISSION_GUARD_DIR, `${name}.json`)
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    if (typeof parsed?.at === "number") return { at: parsed.at }
  } catch (error) {
    if (!(error instanceof Error)) return null
  }
  // Exists but unreadable (partial write, corruption): treat as fresh until its
  // mtime passes the TTL so a second claimer cannot slip through.
  try {
    return { at: statSync(file).mtimeMs }
  } catch (error) {
    if (error instanceof Error) return null
    return null
  }
}

function tryCreateExclusive(file, record) {
  let fd
  try {
    fd = openSync(file, "wx", 0o600)
  } catch (error) {
    if (error instanceof Error && error.code === "EEXIST") return false
    // Unexpected filesystem error: fail open (a duplicate notice is less bad
    // than dropping a required one).
    return "error"
  }
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`)
  } finally {
    closeSync(fd)
  }
  return true
}

function acquireLock(lock, now, lockTtlMs) {
  try {
    const fd = openSync(lock, "wx", 0o600)
    closeSync(fd)
    return true
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "EEXIST") return true
  }
  // Stale lock: the holder died before removing it. Steal it once.
  try {
    const stat = statSync(lock)
    if (now() - stat.mtimeMs > lockTtlMs) {
      unlinkSync(lock)
      const fd = openSync(lock, "wx", 0o600)
      closeSync(fd)
      return true
    }
  } catch (error) {
    if (error instanceof Error) return false
  }
  return false
}

/**
 * Claim an emission. Returns true when this caller is the first to emit the key
 * within `ttlMs`; false when the same key was already claimed. `now` is a
 * millisecond clock seam.
 */
export function claimEmission({ stateRoot, key, ttlMs = 60000, lockTtlMs = DEFAULT_LOCK_TTL_MS, now = Date.now } = {}) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || typeof key !== "string" || key.length === 0) return true
  const file = emissionGuardPath(stateRoot, key)
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (error) {
    if (error instanceof Error) return true
  }

  const at = now()
  const created = tryCreateExclusive(file, { key, at })
  if (created === true) return true
  if (created === "error") return true

  const existing = readRecord(file)
  if (existing && at - existing.at < ttlMs) return false

  // Expired (or vanished) record: one process serializes the reclaim.
  const lock = `${file}.lock`
  if (!acquireLock(lock, now, lockTtlMs)) return false
  try {
    const current = readRecord(file)
    if (current && now() - current.at < ttlMs) return false
    const fd = openSync(file, "w", 0o600)
    try {
      writeSync(fd, `${JSON.stringify({ key, at: now() })}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    if (error instanceof Error) return true
    return true
  } finally {
    try {
      unlinkSync(lock)
    } catch (error) {
      if (!(error instanceof Error)) return
    }
  }
}

/** Release a claimed key (e.g. when the request is answered). Best-effort. */
export function releaseEmission({ stateRoot, key } = {}) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || typeof key !== "string" || key.length === 0) return
  const file = emissionGuardPath(stateRoot, key)
  for (const target of [file, `${file}.lock`]) {
    if (!existsSync(target)) continue
    try {
      rmSync(target)
    } catch (error) {
      if (!(error instanceof Error)) return
    }
  }
}
