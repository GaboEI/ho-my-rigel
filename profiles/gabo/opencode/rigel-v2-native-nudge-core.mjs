/**
 * Pure decision core for the OmO Native edition nudge, ported to the Oh My
 * Rigel V2 companion CLI plugin.
 *
 * V1 owners:
 *   packages/omo-opencode/src/hooks/native-edition-nudge/decide.ts
 *   packages/omo-opencode/src/hooks/native-edition-nudge/types.ts
 *   packages/omo-opencode/src/hooks/native-edition-nudge/hook.ts (host probes)
 *
 * Deterministic and I/O-free: every value the decision ladder reads is passed
 * in, so each branch is unit-testable without a renderer or the filesystem.
 * The two host probes are exported as pure helpers with their dependencies
 * injected (`isInteractiveSession(env, isTTY)`, `detectNativeEdition({ existsSync, home })`).
 */

import { join } from "node:path"

/** V1 `NUDGE_STATE_VERSION`. */
export const NUDGE_STATE_VERSION = 1

export const DAY_MS = 24 * 60 * 60 * 1000

/** V1 `NUDGE_INTERVALS_MS`: the days between accepted showings. */
export const NUDGE_INTERVALS_MS = Object.freeze([3, 7, 14].map((days) => days * DAY_MS))

/** V1 `NUDGE_AUTO_SHOW_CAP`: showings before the nudge is silenced for good. */
export const NUDGE_AUTO_SHOW_CAP = 4

/** V1 `NUDGE_SNOOZE_MS`: a user-requested "later" defers a week. */
export const NUDGE_SNOOZE_MS = 7 * DAY_MS

/** V1 `NUDGE_CORRUPT_RECOVERY_MS`: a damaged state file defers three days. */
export const NUDGE_CORRUPT_RECOVERY_MS = 3 * DAY_MS

/** Every suppression reason the ladder can return (V1 `NudgeSuppressionReason`). */
export const NUDGE_SUPPRESSION_REASONS = Object.freeze([
  "already-migrated",
  "opted-out",
  "non-interactive",
  "child-session",
  "already-shown-this-process",
  "not-yet-eligible",
  "lifetime-cap-reached",
  "state-unwritable",
  "toast-unavailable",
  "state-corrupt-recovering",
])

export function freshNudgeState(now, version = "unknown") {
  return {
    schemaVersion: NUDGE_STATE_VERSION,
    autoShows: 0,
    lastShownAt: null,
    nextEligibleAt: now,
    decision: "none",
    decidedAt: null,
    writtenBy: version,
  }
}

function recoveredState(now, version) {
  return { ...freshNudgeState(now, version), nextEligibleAt: now + NUDGE_CORRUPT_RECOVERY_MS }
}

function shownState(previous, now, version) {
  const autoShows = previous.autoShows + 1
  const index = Math.min(Math.max(autoShows - 1, 0), NUDGE_INTERVALS_MS.length - 1)
  const interval = NUDGE_INTERVALS_MS[index] ?? 0
  return {
    ...previous,
    schemaVersion: NUDGE_STATE_VERSION,
    autoShows,
    lastShownAt: now,
    nextEligibleAt: now + interval,
    writtenBy: version,
  }
}

/**
 * The full decision ladder, ported branch-for-branch from V1 `decideNativeEditionNudge`.
 *
 * A recorded `never`/`migrated` decision outranks every other field, so a
 * corrupted or hand-edited state file can never resurrect a nudge the user
 * already dismissed for good.
 *
 * Returns `{ show: true, reason: "eligible", nextState }` or
 * `{ show: false, reason, nextState }` where `nextState` is the state to persist
 * (or `null` when nothing needs writing).
 */
export function decideNativeEditionNudge(input = {}) {
  const now = typeof input.now === "number" ? input.now : 0
  const version = typeof input.version === "string" && input.version.length > 0 ? input.version : "unknown"
  const state = input.state ?? "missing"
  const deny = (reason, nextState = null) => ({ show: false, reason, nextState })

  if (state !== "missing" && state !== "corrupt") {
    if (state.decision === "never") return deny("opted-out")
    if (state.decision === "migrated") return deny("already-migrated")
  }

  if (input.nativeEditionInstalled === true) return deny("already-migrated")
  if (input.hookDisabled === true) return deny("opted-out")
  if (input.interactive !== true) return deny("non-interactive")
  if (input.childSession === true) return deny("child-session")
  if (input.shownThisProcess === true) return deny("already-shown-this-process")
  if (input.toastAvailable !== true) return deny("toast-unavailable")

  // Probe writability before showing: a nudge that cannot record itself would
  // reappear every session, which is the nagging failure mode this module exists
  // to avoid.
  if (input.stateWritable !== true) return deny("state-unwritable")

  if (state === "corrupt") return deny("state-corrupt-recovering", recoveredState(now, version))

  const current = state === "missing" ? freshNudgeState(now, version) : state
  if (current.autoShows >= NUDGE_AUTO_SHOW_CAP) return deny("lifetime-cap-reached")
  if (now < current.nextEligibleAt) return deny("not-yet-eligible")

  return { show: true, reason: "eligible", nextState: shownState(current, now, version) }
}

/** V1 `snoozedState`: a user-requested deferral. */
export function snoozedState(previous, now, version, snoozeMs = NUDGE_SNOOZE_MS) {
  return { ...previous, nextEligibleAt: now + snoozeMs, decision: "snoozed", decidedAt: now, writtenBy: version }
}

/** V1 `decidedState`: a permanent decision (`never` or `migrated`). */
export function decidedState(previous, now, version, decision) {
  return { ...previous, decision, decidedAt: now, writtenBy: version }
}

/**
 * V1 `defaultInteractive`, made pure: a CI environment or an explicit
 * `OMO_NON_INTERACTIVE=1` suppresses the nudge, otherwise the session must have
 * a TTY.
 */
export function isInteractiveSession(env = {}, isTTY = false) {
  if (env && env.CI !== undefined && env.CI !== "") return false
  if (env && env.OMO_NON_INTERACTIVE === "1") return false
  return isTTY === true
}

/** The native edition's canonical agent directory (`~/.omo/agent`). */
export function nativeEditionAgentDir(home) {
  return join(home, ".omo", "agent")
}

/**
 * V1 `detectNativeEdition`: a native install is present when its canonical
 * agent dir exists. `existsSync` and `home` are injected so the probe is
 * testable and never touches the real home in unit tests.
 */
export function detectNativeEdition({ existsSync, home } = {}) {
  if (typeof existsSync !== "function" || typeof home !== "string" || home.length === 0) return false
  try {
    return existsSync(nativeEditionAgentDir(home)) === true
  } catch {
    return false
  }
}
