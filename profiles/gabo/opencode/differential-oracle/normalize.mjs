/**
 * Normalization and tolerance comparison for the Differential oracle differential oracle.
 *
 * Two byte-for-byte equal observables are the exception, not the rule: V1 and
 * V2 hand back session ids, absolute paths, timestamps, and object key order
 * that legitimately differ while the behavior is identical. `normalize` erases
 * only those environment-dependent volatiles; it never erases a value the
 * behavior could depend on. `compare` then applies the scenario's declared
 * tolerance, and refuses every tolerance it cannot evaluate (a comparator that
 * silently passes is worse than a failing one).
 */

import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..")

/** Object keys whose value is per-run state, never the behavior under test. */
const VOLATILE_KEYS = new Set([
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "timeCreated",
  "timeUpdated",
  "timestamp",
  "pid",
  "sessionID",
  "sessionId",
  "messageID",
  "messageId",
  "requestID",
  "requestId",
  "callID",
  "callId",
  "toolCallId",
  "tool_call_id",
])

/** Id-looking tokens that differ across runs but describe the same entity. */
const ID_TOKEN = /\b(?:ses|msg|prt|req|run|evt|wsp|toolu)_[A-Za-z0-9_]+\b/g

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Build the volatile-string replacement table. Roots are matched longest-first
 * so the temp dir (nested under some homes on macOS) wins before $HOME.
 */
function replacements(roots) {
  const table = [
    { needle: roots.repoRoot, token: "<REPO>" },
    { needle: roots.tmp, token: "<TMP>" },
    { needle: roots.home, token: "<HOME>" },
  ]
  return table
    .filter((entry) => typeof entry.needle === "string" && entry.needle.length > 0)
    .sort((a, b) => b.needle.length - a.needle.length)
}

function normalizeString(value, table) {
  let text = value.replace(/\r\n/g, "\n")
  for (const { needle, token } of table) {
    text = text.replace(new RegExp(escapeRegExp(needle), "g"), token)
  }
  return text.replace(ID_TOKEN, "<ID>")
}

function normalizeValue(value, table, seen) {
  if (typeof value === "string") return normalizeString(value, table)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "<CYCLE>"
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = value.map((entry) => normalizeValue(entry, table, seen))
  } else {
    result = {}
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue
      result[key] = normalizeValue(value[key], table, seen)
    }
  }
  seen.delete(value)
  return result
}

/**
 * Normalize an observable. Pass `roots` to pin the environment in a test.
 * @param {unknown} value
 * @param {{ repoRoot?: string, home?: string, tmp?: string }} [roots]
 */
export function normalize(value, roots = {}) {
  const resolved = {
    repoRoot: roots.repoRoot ?? REPO_ROOT,
    home: roots.home ?? os.homedir(),
    tmp: roots.tmp ?? os.tmpdir(),
  }
  return normalizeValue(value, replacements(resolved), new Set())
}

/** Stable deep equality over JSON-shaped values (used by most tolerances). */
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((entry, index) => deepEqual(entry, b[index]))
  }
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]))
}

function stableSortKey(value) {
  return JSON.stringify(value)
}

/**
 * Tolerance comparators. Each returns `{ ok, detail }`; an unknown tolerance
 * kind returns `{ ok: false, detail }` so a typo cannot pass.
 *
 * - `exact` / `ordered`: deep equality (order significant for arrays)
 * - `set`: array equality ignoring order
 * - `substring`: `needle` (a) is contained in `haystack` (b)
 * - `numeric-range`: |a - b| <= abs (default 0)
 * - `artifact-equality`: deep equality of two real exported artifacts, kept as
 *   an explicit kind so a prose artifact drift guard is never mistaken for a
 *   behavioral comparison.
 */
export const COMPARATORS = Object.freeze({
  exact(a, b) {
    return { ok: deepEqual(a, b), detail: "deep equality" }
  },
  ordered(a, b) {
    return { ok: deepEqual(a, b), detail: "ordered array equality" }
  },
  set(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return { ok: false, detail: "set tolerance requires two arrays" }
    }
    const sa = [...a].map(stableSortKey).sort()
    const sb = [...b].map(stableSortKey).sort()
    return { ok: deepEqual(sa, sb), detail: "order-insensitive set equality" }
  },
  substring(a, b) {
    if (typeof a !== "string" || typeof b !== "string") {
      return { ok: false, detail: "substring tolerance requires two strings" }
    }
    return { ok: b.includes(a), detail: "needle contained in haystack" }
  },
  "numeric-range"(a, b, tolerance) {
    if (typeof a !== "number" || typeof b !== "number") {
      return { ok: false, detail: "numeric-range tolerance requires two numbers" }
    }
    const abs = typeof tolerance.abs === "number" ? tolerance.abs : 0
    return { ok: Math.abs(a - b) <= abs, detail: `|a-b| <= ${abs}` }
  },
  "artifact-equality"(a, b) {
    return { ok: deepEqual(a, b), detail: "two-artifact equality (drift guard)" }
  },
})

/**
 * Compare two already-normalized observables under a declared tolerance.
 * @param {unknown} a
 * @param {unknown} b
 * @param {{ kind: string, abs?: number }} tolerance
 */
export function compare(a, b, tolerance = { kind: "exact" }) {
  const comparator = COMPARATORS[tolerance.kind]
  if (!comparator) {
    return { ok: false, kind: tolerance.kind, detail: `unknown tolerance kind "${tolerance.kind}"` }
  }
  const result = comparator(a, b, tolerance)
  return { ok: result.ok, kind: tolerance.kind, detail: result.detail }
}
