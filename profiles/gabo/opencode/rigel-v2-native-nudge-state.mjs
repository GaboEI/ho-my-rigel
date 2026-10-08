/**
 * Durable state store for the OmO Native edition nudge, ported to the Oh My
 * Rigel V2 companion CLI plugin.
 *
 * V1 owner: packages/omo-opencode/src/hooks/native-edition-nudge/state.ts
 *
 * One JSON file, schemaVersion 1, with the V1 fields:
 *   autoShows, lastShownAt, nextEligibleAt, decision(none|snoozed|never|migrated),
 *   decidedAt, writtenBy.
 *
 * `read()` returns the state, `"missing"`, or `"corrupt"` - a damaged file must
 * never crash a session. Writability is probed with a real file write, because a
 * directory can exist and still reject a write, and a nudge that cannot record
 * itself would reappear every session.
 *
 * The V1 store lived under the user config dir; V2 keeps durable companion
 * state under `$XDG_STATE_HOME/oh-my-rigel`, matching the notification log and
 * the legacy-notice receipt. Every fs primitive is injectable via `deps`.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { NUDGE_STATE_VERSION } from "./rigel-v2-native-nudge-core.mjs"

/** V1 `NUDGE_STATE_FILE`. */
export const NUDGE_STATE_FILE = "native-nudge.json"

/** V1 `nativeEditionStateDir`, adapted to the V2 XDG state root. */
export function resolveNudgeStateDir({ env = {}, home } = {}) {
  const stateHome =
    typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(typeof home === "string" && home.length > 0 ? home : homedir(), ".local", "state")
  return join(stateHome, "oh-my-rigel")
}

function isDecision(value) {
  return value === "none" || value === "snoozed" || value === "never" || value === "migrated"
}

function isEpoch(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * Parse a raw state file body. A missing/invalid `decision` or `nextEligibleAt`
 * means corrupt; every other field is defaulted rather than failing the parse,
 * so a file written by a future version never makes the nudge unusable.
 */
export function parseNudgeState(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "corrupt"
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "corrupt"
  if (!isDecision(parsed.decision)) return "corrupt"
  if (!isEpoch(parsed.nextEligibleAt)) return "corrupt"
  return {
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : NUDGE_STATE_VERSION,
    autoShows:
      typeof parsed.autoShows === "number" && Number.isSafeInteger(parsed.autoShows) && parsed.autoShows >= 0
        ? parsed.autoShows
        : 0,
    lastShownAt: isEpoch(parsed.lastShownAt) ? parsed.lastShownAt : null,
    nextEligibleAt: parsed.nextEligibleAt,
    decision: parsed.decision,
    decidedAt: isEpoch(parsed.decidedAt) ? parsed.decidedAt : null,
    writtenBy: typeof parsed.writtenBy === "string" ? parsed.writtenBy : "unknown",
  }
}

/**
 * Create a durable state store rooted at `stateDir`. The fs primitives are
 * injectable; the defaults are the `node:fs` sync APIs.
 */
export function createNudgeStateStore(stateDir, deps = {}) {
  const readFile = deps.readFileSync ?? readFileSync
  const writeFile = deps.writeFileSync ?? writeFileSync
  const makeDir = deps.mkdirSync ?? mkdirSync
  const removeFile = deps.unlinkSync ?? unlinkSync
  const path = join(stateDir, NUDGE_STATE_FILE)

  return {
    read() {
      let raw
      try {
        raw = readFile(path, "utf8")
      } catch {
        return "missing"
      }
      return parseNudgeState(raw)
    },
    write(state) {
      try {
        makeDir(stateDir, { recursive: true })
        writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
        return true
      } catch {
        return false
      }
    },
    probeWritable() {
      const probe = join(stateDir, `.${NUDGE_STATE_FILE}.probe`)
      try {
        makeDir(stateDir, { recursive: true })
        writeFile(probe, "", { mode: 0o600 })
      } catch {
        return false
      }
      try {
        removeFile(probe)
      } catch {
        // The probe file is disposable; failing to remove it does not make the dir unwritable.
      }
      return true
    },
  }
}
