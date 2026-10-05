/**
 * `tool.execute.after` binders for the native OpenCode V2 runtime.
 *
 * This module exports thin rules over the T9 pure flow logic
 * (`./rigel-v2-flow-logic.mjs`). Each rule is a `{ name, run }` object, so the
 * runtime composes it with `runOrderedRules` (`./rigel-v2-native-hook-chain.mjs`)
 * and a throwing rule is isolated instead of aborting the rest of the chain.
 * No decision lives here: the delegate-retry branch is `decideDelegateRetry`,
 * and the fsync filter + formatter are `pairFsyncSkips` /
 * `formatFsyncSkipWarning`. The only non-decision port this module needs is the
 * V1 detector and guidance factory (`./rigel-v2-delegate-retry-core.mjs`),
 * because the plain-ESM runtime cannot import the TypeScript V1 owners.
 *
 * read-image-resizer is deliberately NOT wired here. T10 recorded a NO-GO for
 * the `execute.after` seam: the real V2 payload carries no `provider`, no
 * `model`, and no `attachments`, and `result.content` is an array of
 * `{ type, text }` parts with no attachment URLs, so both the V1 provider gate
 * (`getSessionModel(sessionID).providerID === "anthropic"`) and the in-place
 * attachment mutation are unreproducible at this boundary. Per
 * `.omo/evidence/20261005-task-20/t10-resizer-seam-verdict.md`, shipping a
 * binder here would be either a silent no-op or a fabricated resize claim, so
 * the surface keeps only its tested pure core
 * (`rigel-v2-native-image-resizer.mjs`) and this module adds no rule, mock, or
 * stub for it.
 */

import {
  decideDelegateRetry,
  formatFsyncSkipWarning,
  pairFsyncSkips,
} from "./rigel-v2-flow-logic.mjs"
import {
  buildRetryGuidance,
  detectDelegateTaskError,
} from "./rigel-v2-delegate-retry-core.mjs"

/** V1 `MAX_SKIPS` for the fsync tracker (see shared/fsync-skip-tracker.ts). */
export const MAX_FSYNC_SKIPS = 200

/**
 * Append text to whichever mutable result channel the after event exposes.
 * T1 proved `event.result.content` is a mutable array of `{ type, text }`
 * parts; a string channel is also honored so the binder degrades honestly on a
 * shape the probe did not pin. Returns true when the text landed.
 */
function appendResultText(event, text) {
  if (!event || typeof event !== "object") return false
  const content = event.result?.content
  if (Array.isArray(content)) {
    content.push({ type: "text", text })
    return true
  }
  if (typeof content === "string") {
    event.result.content = content + text
    return true
  }
  if (typeof event.result?.output === "string") {
    event.result.output += text
    return true
  }
  if (typeof event.output === "string") {
    event.output += text
    return true
  }
  return false
}

/**
 * Delegate-retry rule per the T3 verdict (`oq5-decision.md`).
 *
 * Trigger surface is the ERROR CHANNEL only: `decideDelegateRetry` bails unless
 * `status === "error"` and the extracted `event.error` / `event.result.error`
 * text is non-empty. A success or a background spawn therefore never appends,
 * which removes the V1 child-text false positive. A matching V1 pattern yields
 * `buildRetryGuidance`; an error with no match yields the T9 generic
 * announce/recover notice. `missing_run_in_background` is dropped by the glue.
 *
 * The detector and guidance are injectable so a test can pin either branch; the
 * defaults are the ported V1 cores.
 */
export function createDelegateTaskRetryRule({
  detect = detectDelegateTaskError,
  buildGuidance = buildRetryGuidance,
} = {}) {
  return {
    name: "delegate-task-retry",
    run(event) {
      const decision = decideDelegateRetry(event, { detect, buildGuidance })
      if (!decision || decision.action === "none" || !decision.text) return false
      return appendResultText(event, `\n${decision.text}`)
    },
  }
}

function fsyncCallId(event) {
  const id = event?.id
  return id === undefined || id === null ? null : id
}

/**
 * Stateful fsync-skip tracker: the before side records the call start keyed by
 * the stable call id (T1: `event.id` is equal across before/after), the after
 * side drains the skips recorded past that start and formats the V1 warning.
 *
 * A factory (not a module singleton) so callers and tests hold an isolated
 * instance. `recordSkip` is the producer seam the write path uses to report a
 * skipped fsync; `recordStart`, `drain`, and `clear` are the hook side.
 */
export function createFsyncSkipWarningState({ maxSkips = MAX_FSYNC_SKIPS } = {}) {
  const startById = new Map()
  let skips = []

  return {
    /** Record the before-event start per stable call id. */
    recordStart(event) {
      const id = fsyncCallId(event)
      if (id === null) return false
      const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
      startById.set(String(id), timestamp)
      return true
    },

    /** Record one skipped-fsync report. FIFO-capped like V1 `MAX_SKIPS`. */
    recordSkip(entry) {
      const timestamp = typeof entry?.timestamp === "number" ? entry.timestamp : Date.now()
      skips.push({ ...entry, timestamp })
      if (skips.length > maxSkips) skips.splice(0, skips.length - maxSkips)
    },

    /**
     * Drain the skips recorded strictly after this call's start.
     *
     * Uses the T9 `pairFsyncSkips` watermark to select the entries whose
     * timestamp is greater than the recorded start. When no before start was
     * recorded for this id there is no window to drain, so the call yields
     * nothing instead of claiming every pending skip. Drained entries are
     * consumed so a later call cannot double-report them.
     */
    drain(event) {
      const id = fsyncCallId(event)
      if (id === null) return []
      const key = String(id)
      if (!startById.has(key)) return []
      const startTimestamp = startById.get(key)
      startById.delete(key)
      const beforeEvent = { id, timestamp: startTimestamp }
      const drained = pairFsyncSkips(beforeEvent, event, skips)
      if (drained.length === 0) return []
      const drainedSet = new Set(drained)
      skips = skips.filter((entry) => !drainedSet.has(entry))
      return drained
    },

    clear() {
      startById.clear()
      skips = []
    },
  }
}

/** fsync-skip-warning after rule: append the exact V1 warning block. */
export function createFsyncSkipWarningRule(state) {
  return {
    name: "fsync-skip-warning",
    run(event) {
      const drained = state.drain(event)
      if (drained.length === 0) return false
      const warning = formatFsyncSkipWarning(drained)
      if (!warning) return false
      return appendResultText(event, `\n\n${warning}`)
    },
  }
}

/** fsync-skip-warning before rule: record the call start. */
export function createFsyncSkipStartRule(state) {
  return {
    name: "fsync-skip-warning:record-start",
    run(event) {
      return state.recordStart(event)
    },
  }
}

const defaultFsyncState = createFsyncSkipWarningState()

/**
 * `tool.execute.after` rules appended after the built-in result transforms.
 * Frozen and empty-safe: always an array, so the runtime can spread it even
 * when a future gate removes every rule.
 */
export const afterRules = Object.freeze([
  createDelegateTaskRetryRule(),
  createFsyncSkipWarningRule(defaultFsyncState),
])

/**
 * Companion before rules the runtime appends to `beforeRules` so the fsync
 * tracker records the call start on the same stable id the after rule drains.
 * Named separately from `afterRules` to keep the seam explicit.
 */
export const fsyncSkipBeforeRules = Object.freeze([
  createFsyncSkipStartRule(defaultFsyncState),
])
