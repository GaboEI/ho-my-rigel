/**
 * Canonical project scope for the native V2 team model.
 *
 * Team records and the cleanup journal live in the plugin-global `ctx.storage`,
 * so a bare team name would collide across projects and let one project's
 * reconcile or event handler touch another project's resources. Every team and
 * journal record is therefore namespaced by a stable, path-safe project key:
 *
 *   team    ... rigel-v2/team/<projectKey>/<teamName>
 *   journal ... rigel-v2/team-cleanup/<projectKey>/<teamName>
 *
 * The key prefers the V2 stable project id and, when it is absent, a hash of the
 * project's canonical directory. It never embeds a raw filesystem path, so a key
 * is always a safe single storage segment. Reads, listings, event handlers,
 * tools, reconciliation and the orphan sweep are all bounded to the active
 * project's key.
 *
 * Legacy records written before scoping (`rigel-v2/team/<name>` with no project
 * segment) are migrated only when their member worktree paths prove they belong
 * to the current repo; a record owned by another repo is never adopted or
 * deleted.
 */

import { createHash } from "node:crypto"

export const TEAM_RECORD_ROOT = "rigel-v2/team/"
export const CLEANUP_RECORD_ROOT = "rigel-v2/team-cleanup/"
export const DEFAULT_PROJECT_KEY = "p-default"

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/
const UNSAFE_NAME = /[\u0000-\u001f]/

/**
 * Keep user-provided team/member names unconstrained (spaces, `@`, `:`, Unicode
 * all stay allowed); only an empty name or an embedded control character is
 * rejected. Names are never used verbatim in a path, branch or key.
 */
export function validateNameSegment(name, label = "name") {
  const value = String(name ?? "")
  if (value.length === 0) throw new Error(`${label} must be non-empty`)
  if (UNSAFE_NAME.test(value)) throw new Error(`${label} contains an unsupported control character`)
  return value
}

/**
 * Git-safe, reversible, collision-resistant encoding of a name segment: every
 * byte outside `[A-Za-z0-9_-]` becomes `%XX`. The mapping is injective, so two
 * distinct names ("foo bar" vs "foo-bar") never share a worktree directory,
 * branch or storage-key segment, and the output is a valid Git ref component
 * (no space, `~^:?*[\`, `..`, leading dot or `.lock`).
 */
export function encodeNameSegment(name, label = "name") {
  const value = validateNameSegment(name, label)
  let out = ""
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = byte < 0x80 ? String.fromCharCode(byte) : ""
    if (ch && /[A-Za-z0-9_-]/.test(ch)) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return out
}

export function sanitizeProjectKey(value) {
  const raw = String(value ?? "").trim()
  if (!raw) throw new Error("project key must be non-empty")
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/[-.]+$/, "")
  if (!safe || !SAFE_SEGMENT.test(safe)) throw new Error(`project key is not a safe storage segment: ${value}`)
  return safe
}

export function resolveProjectKey({ projectId, repoRoot } = {}) {
  const id = typeof projectId === "string" ? projectId.trim() : ""
  if (id && SAFE_SEGMENT.test(id)) return `p-${id}`
  const root = typeof repoRoot === "string" ? repoRoot.trim() : ""
  if (!root) throw new Error("project scope requires a projectId or a repoRoot")
  return `h-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`
}

export function teamRecordKey(projectKey, name) {
  return `${TEAM_RECORD_ROOT}${sanitizeProjectKey(projectKey)}/${encodeNameSegment(name, "team name")}`
}

export function teamRecordsPrefix(projectKey) {
  return `${TEAM_RECORD_ROOT}${sanitizeProjectKey(projectKey)}/`
}

export function cleanupRecordKey(projectKey, name) {
  return `${CLEANUP_RECORD_ROOT}${sanitizeProjectKey(projectKey)}/${encodeNameSegment(name, "team name")}`
}

export function cleanupRecordsPrefix(projectKey) {
  return `${CLEANUP_RECORD_ROOT}${sanitizeProjectKey(projectKey)}/`
}

/** A legacy team key has no project segment: exactly one segment after the root. */
export function isLegacyTeamKey(key) {
  if (typeof key !== "string" || !key.startsWith(TEAM_RECORD_ROOT)) return false
  const rest = key.slice(TEAM_RECORD_ROOT.length)
  return rest.length > 0 && !rest.includes("/")
}

export function isLegacyCleanupKey(key) {
  if (typeof key !== "string" || !key.startsWith(CLEANUP_RECORD_ROOT)) return false
  const rest = key.slice(CLEANUP_RECORD_ROOT.length)
  return rest.length > 0 && !rest.includes("/")
}

/**
 * Ownership proof for a legacy record: every declared member worktree path is
 * under `repoRoot`. A record with no worktree paths is ambiguous and is never
 * adopted (it could belong to another repo).
 */
export function isOwnedByRepo(members, repoRoot) {
  const root = typeof repoRoot === "string" ? repoRoot.replace(/\/+$/, "") : ""
  if (!root) return false
  const paths = (members ?? []).map((member) => member?.worktreePath).filter((value) => typeof value === "string" && value.length > 0)
  if (paths.length === 0) return false
  return paths.every((value) => value === root || value.startsWith(`${root}/`))
}
