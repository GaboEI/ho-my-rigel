/**
 * On-disk continuation marker for Oh My Rigel's native OpenCode V2 background
 * children.
 *
 * The V2-native background agent keeps its running-child table in memory (the
 * V2 event stream is the source of truth), so the ONLY background persistence
 * that matters is the same one V1 keeps: a per-parent-session continuation
 * marker that tells a restarted `run` / resume path that background work is
 * still active.
 *
 * Plain-JS port of the matching OmO revision:
 *   packages/omo-opencode/src/features/run-continuation-state/storage.ts
 *     getMarkerPath / readContinuationMarker / setContinuationMarkerSource /
 *     clearContinuationMarker   (marker file `<dir>/.omo/run-continuation/<sessionID>.json`)
 *   packages/omo-opencode/src/features/run-continuation-state/constants.ts
 *     CONTINUATION_MARKER_DIR = ".omo/run-continuation"
 *   packages/omo-opencode/src/features/background-agent/background-task-marker.ts
 *     writeBackgroundTaskMarker   (active count > 0 -> active; undelivered wake
 *     -> active "background completion wake pending"; else idle)
 *
 * The marker file is shared with other continuation sources (`todo`, `stop`),
 * so this module rewrites only the `background-task` entry and preserves the
 * rest of the file, exactly like V1 `setContinuationMarkerSource`. Marker I/O is
 * best-effort: a filesystem failure never breaks the runtime.
 *
 * Pure persistence: no imports beyond `node:fs` / `node:path`, no state.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Marker directory relative to the project directory (V1 `CONTINUATION_MARKER_DIR`). */
export const CONTINUATION_MARKER_DIR = ".omo/run-continuation"

/** The continuation source this module owns (V1 `ContinuationMarkerSource`). */
export const BACKGROUND_MARKER_SOURCE = "background-task"

/** The `stop` continuation source the `/stop-continuation` guard owns (V1 `setContinuationMarkerSource(..., "stop", ...)`). */
export const STOP_MARKER_SOURCE = "stop"

/** Reason recorded while a finished child's parent wake is still undelivered. */
export const BACKGROUND_WAKE_PENDING_REASON = "background completion wake pending"

function markerPath(directory, sessionID) {
  return join(directory, CONTINUATION_MARKER_DIR, `${sessionID}.json`)
}

function isDirectory(value) {
  return typeof value === "string" && value.length > 0
}

/**
 * Read the `background-task` marker entry for a session, mirroring V1
 * `readContinuationMarker` narrowed to the source this module owns. Returns
 * `{ state, reason?, updatedAt }` or null when the file is absent, malformed,
 * or holds no `background-task` entry.
 */
export function readBackgroundMarker(directory, sessionID) {
  if (!isDirectory(directory) || typeof sessionID !== "string" || sessionID.length === 0) return null
  const file = markerPath(directory, sessionID)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const entry = parsed.sources?.[BACKGROUND_MARKER_SOURCE]
    if (!entry || typeof entry !== "object") return null
    return { state: entry.state, reason: entry.reason, updatedAt: entry.updatedAt }
  } catch (error) {
    if (error instanceof Error) return null
    return null
  }
}

function readExistingSources(file) {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sources && typeof parsed.sources === "object") {
      return parsed.sources
    }
    return {}
  } catch (error) {
    if (error instanceof Error) return {}
    return {}
  }
}

/**
 * Write the `background-task` continuation marker for `parentSessionID`,
 * mirroring V1 `writeBackgroundTaskMarker`:
 *   activeTaskCount > 0                  -> active, `<n> background task(s) active`
 *   else hasUndeliveredParentWake        -> active, `background completion wake pending`
 *   else                                 -> idle
 *
 * `now` is an optional `() => string` seam so a caller can pin the timestamp.
 * Existing non-background sources in the same file are preserved.
 */
export function writeBackgroundMarker(input, now) {
  const directory = input?.directory
  const parentSessionID = input?.parentSessionID
  if (!isDirectory(directory) || typeof parentSessionID !== "string" || parentSessionID.length === 0) return
  const timestamp = typeof now === "function" ? now() : new Date().toISOString()
  const file = markerPath(directory, parentSessionID)
  const activeTaskCount = input?.activeTaskCount ?? 0
  const hasUndeliveredParentWake = input?.hasUndeliveredParentWake === true
  const entry = activeTaskCount > 0
    ? { state: "active", reason: `${activeTaskCount} background task(s) active`, updatedAt: timestamp }
    : hasUndeliveredParentWake
      ? { state: "active", reason: BACKGROUND_WAKE_PENDING_REASON, updatedAt: timestamp }
      : { state: "idle", updatedAt: timestamp }
  const next = {
    sessionID: parentSessionID,
    updatedAt: timestamp,
    sources: { ...readExistingSources(file), [BACKGROUND_MARKER_SOURCE]: entry },
  }
  try {
    mkdirSync(join(directory, CONTINUATION_MARKER_DIR), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2), "utf-8")
  } catch (error) {
    if (error instanceof Error) return
    return
  }
}

/**
 * Write the `stop` continuation marker for a session, mirroring V1
 * `setContinuationMarkerSource(directory, sessionID, "stop", state)`:
 * `/stop-continuation` sets `stopped`, and clearing it sets `idle`. The stop
 * entry is written into the SHARED marker file without touching any other
 * source (`background-task`, `todo`). `state` is `"stopped"` or `"idle"`; `now`
 * is an optional `() => string` timestamp seam. Best-effort.
 */
export function writeStopMarker(directory, sessionID, state, now) {
  if (!isDirectory(directory) || typeof sessionID !== "string" || sessionID.length === 0) return
  const timestamp = typeof now === "function" ? now() : new Date().toISOString()
  const file = markerPath(directory, sessionID)
  const normalized = state === "stopped" ? "stopped" : "idle"
  const next = {
    sessionID,
    updatedAt: timestamp,
    sources: { ...readExistingSources(file), [STOP_MARKER_SOURCE]: { state: normalized, updatedAt: timestamp } },
  }
  try {
    mkdirSync(join(directory, CONTINUATION_MARKER_DIR), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2), "utf-8")
  } catch (error) {
    if (error instanceof Error) return
    return
  }
}

/**
 * Remove the whole marker file for a session, mirroring V1
 * `clearContinuationMarker` (a deleted session must not leave an active
 * continuation behind). Best-effort.
 */
export function clearBackgroundMarker(directory, sessionID) {
  if (!isDirectory(directory) || typeof sessionID !== "string" || sessionID.length === 0) return
  const file = markerPath(directory, sessionID)
  if (!existsSync(file)) return
  try {
    rmSync(file)
  } catch (error) {
    if (error instanceof Error) return
    return
  }
}
