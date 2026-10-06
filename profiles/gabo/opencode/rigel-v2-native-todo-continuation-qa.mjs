/**
 * QA control seam for the native V2 todo-continuation failure/cooldown gate.
 *
 * The deployed OpenCode V2 host accepts an internal prompt at enqueue: a
 * provider, model or session error surfaces later as `session.error` (see
 * `SessionProcessor.halt`) instead of rejecting `context.session.prompt`. A real
 * transport or provider failure therefore cannot drive the enforcer's
 * `consecutiveFailures` path from the lab. This module is the documented,
 * default-off QA seam that lets the isolated lab force that rejection through
 * the DEPLOYED runtime, without changing product behavior when it is unused.
 *
 * Inert by default: with no control file under the runtime's own state root,
 * `wrapDispatch` calls the real dispatch unchanged and `observeAfterIdle` does
 * nothing. When the file exists it is read on every dispatch and every idle, so
 * the driver can arm, observe and disarm the rejection while the runtime runs.
 *
 * Control file (`<XDG_STATE_HOME>/oh-my-rigel/todo-continuation-qa.json`):
 *   {
 *     "observe": true,               // append one trace line per idle observation
 *     "rejectInjections": 5,         // reject the next N dispatch calls, then pass through
 *     "rejectReason": "..."          // message carried by the forced rejection
 *   }
 *
 * Trace file (`<XDG_STATE_HOME>/oh-my-rigel/todo-continuation-qa-trace.jsonl`)
 * carries the enforcer state after each accepted idle, so the failure counter,
 * cooldown and `inFlight` are read from the runtime rather than asserted from
 * the module under test.
 */
import fs from "node:fs"
import path from "node:path"

export const QA_CONTROL_FILE = "todo-continuation-qa.json"
export const QA_TRACE_FILE = "todo-continuation-qa-trace.jsonl"
export const QA_STATE_DIR = "oh-my-rigel"
export const DEFAULT_REJECT_REASON = "todo-continuation QA forced dispatch rejection"

/**
 * @param {object} [options]
 * @param {string} [options.stateRoot] Runtime state root; defaults to the
 *   process `XDG_STATE_HOME` the lab service sets. Absent root means the seam
 *   is disabled and every operation is inert.
 * @param {() => number} [options.now]
 * @param {typeof import("node:fs")} [options.fsImpl]
 */
export function createTodoContinuationQa({ stateRoot = process.env.XDG_STATE_HOME, now = () => Date.now(), fsImpl = fs } = {}) {
  const dir = typeof stateRoot === "string" && stateRoot.length > 0 ? path.join(stateRoot, QA_STATE_DIR) : undefined
  const controlPath = dir ? path.join(dir, QA_CONTROL_FILE) : undefined
  const tracePath = dir ? path.join(dir, QA_TRACE_FILE) : undefined
  let chain = Promise.resolve()

  function readControl() {
    if (!controlPath) return {}
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(controlPath, "utf8"))
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeControl(control) {
    if (!controlPath) return
    try {
      fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fsImpl.writeFileSync(controlPath, JSON.stringify(control, null, 2) + "\n", { mode: 0o600 })
    } catch {
      /* an unreadable state root leaves the seam inert */
    }
  }

  function arm(patch) {
    const next = { ...readControl(), ...patch }
    writeControl(next)
    return next
  }

  function disarm() {
    if (!controlPath) return
    try {
      fsImpl.rmSync(controlPath, { force: true })
    } catch {
      /* already absent */
    }
  }

  /**
   * Wrap the real dispatch. When the control file arms `rejectInjections`, the
   * next call consumes one rejection and throws instead of reaching the host;
   * once the budget is spent the real dispatch runs untouched.
   */
  function wrapDispatch(realDispatch) {
    return (input) => {
      const run = chain.then(async () => {
        const control = readControl()
        const remaining = Number(control.rejectInjections)
        if (Number.isFinite(remaining) && remaining > 0) {
          writeControl({ ...control, rejectInjections: remaining - 1 })
          throw new Error(typeof control.rejectReason === "string" && control.rejectReason ? control.rejectReason : DEFAULT_REJECT_REASON)
        }
        return realDispatch(input)
      })
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }
  }

  /** Append one trace line with the enforcer state read after an idle. */
  function observeAfterIdle({ sessionID, decision, state } = {}) {
    if (!tracePath) return
    const control = readControl()
    if (control.observe !== true) return
    const entry = {
      at: now(),
      sessionID: sessionID ?? null,
      action: decision?.action ?? null,
      reason: decision?.reason ?? null,
      consecutiveFailures: state?.consecutiveFailures ?? null,
      inFlight: state?.inFlight ?? null,
      lastInjectedAt: state?.lastInjectedAt ?? null,
      stagnationCount: state?.stagnationCount ?? null,
      awaitingPostInjectionProgressCheck: state?.awaitingPostInjectionProgressCheck ?? null,
    }
    try {
      fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fsImpl.appendFileSync(tracePath, JSON.stringify(entry) + "\n", { mode: 0o600 })
    } catch {
      /* observation is best-effort; a missing root is already inert */
    }
  }

  function resetTrace() {
    if (!tracePath) return
    try {
      fsImpl.rmSync(tracePath, { force: true })
    } catch {
      /* already absent */
    }
  }

  return {
    enabled: Boolean(dir),
    controlPath,
    tracePath,
    readControl,
    writeControl,
    arm,
    disarm,
    wrapDispatch,
    observeAfterIdle,
    resetTrace,
  }
}
