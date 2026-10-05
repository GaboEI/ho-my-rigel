/**
 * Event-driven background-child manager for Oh My Rigel's native OpenCode V2
 * runtime.
 *
 * Admission happens BEFORE any child is created or prompted. `admit(descriptor)`
 * decides synchronously whether the child may start now (its concurrency bucket
 * is below the limit) or must wait; a waiting descriptor is stored as an
 * executable record and starts NOTHING until a slot frees. `releaseSlot` starts
 * exactly the next FIFO descriptor through the injected `startChild` callback, so
 * `defaultConcurrency` / `providerConcurrency` / `modelConcurrency` gate REAL
 * execution, not just accounting.
 *
 * The admission key is resolved from the fully-resolved model at admission (the
 * category model, or the agent's proactive model captured at setup). A running
 * child is NEVER re-keyed: a mid-run model fallback changes the model in use but
 * not its admission bucket, which is what prevents over-execution. There is no
 * `rekey` here, by design.
 *
 * State is durable: `rigel-v2-background-state.mjs` persists queued descriptors,
 * active children, and undelivered wakes per parent session, and `restore()`
 * reconciles them at setup so a restart does not lose the queue or the wakes and
 * does not duplicate a started child.
 *
 * The parent-wake handoff stays a non-blocking FIFO pump and there is no
 * `setInterval` / `setTimeout`: the only wake-up source is an event or a tool
 * result.
 */

import { randomUUID } from "node:crypto"
import { createBackgroundQueue } from "./rigel-v2-background-queue.mjs"
import { decideBackgroundRetry } from "./rigel-v2-background-retry.mjs"
import {
  clearBackgroundMarker,
  readBackgroundMarker,
  writeBackgroundMarker,
} from "./rigel-v2-background-marker.mjs"
import { createNoopBackgroundState } from "./rigel-v2-background-state.mjs"
import { MAX_WAKE_ATTEMPTS, createHandoffPump } from "./rigel-v2-background-handoff.mjs"

export { readBackgroundMarker, writeBackgroundMarker, clearBackgroundMarker, MAX_WAKE_ATTEMPTS }

// Compaction-history budget, mirrored from the V1 owner
// (`packages/omo-opencode/src/features/background-agent/task-history.ts`): at
// most 20 delegated sessions, each description capped at 240 chars, and the
// whole summary capped at 6000 chars. `formatCompactionHistory` is pure and is
// the single owner of the bounded formatter used by the manager's
// `formatForCompaction`.
const MAX_COMPACTION_ENTRIES = 20
const MAX_COMPACTION_DESCRIPTION_CHARS = 240
const MAX_COMPACTION_TOTAL_CHARS = 6000
const COMPACTION_TRUNCATION_SUFFIX = "... [truncated]"

/**
 * Render bounded, line-oriented compaction history for delegated sessions.
 *
 * Each entry carries `{ id, agent, category, status, resultStatus, sessionID,
 * description }`; a raw background record's `taskId`/`prompt`/object `agent` and
 * `category` are also accepted. The newest entries are listed first, at most 20
 * are kept, and both the per-entry description and the whole summary are
 * bounded. Returns null for an empty input. Pure: it reads its argument and
 * returns a string, never mutating the input.
 */
export function formatCompactionHistory(entries) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return null
  const recent = list.slice(-MAX_COMPACTION_ENTRIES)
  const olderOmittedCount = list.length - recent.length
  const lines = []
  if (olderOmittedCount > 0) {
    lines.push(compactionOmittedSummary(olderOmittedCount))
  }
  let budgetOmittedCount = 0
  for (let index = recent.length - 1; index >= 0; index--) {
    const entry = recent[index]
    if (!entry) continue
    const line = formatCompactionEntry(entry)
    if (!appendWithinBudget(lines, line, MAX_COMPACTION_TOTAL_CHARS)) {
      budgetOmittedCount = index + 1
      break
    }
  }
  if (budgetOmittedCount > 0) {
    appendBudgetSummary(lines, budgetOmittedCount)
  }
  return lines.join("\n")
}

function compactionOmittedSummary(count) {
  return `- ${count} delegated sessions omitted to stay within compaction budget.`
}

function nameOf(value) {
  if (value && typeof value === "object") return typeof value.name === "string" ? value.name : ""
  return value ?? ""
}

function formatCompactionEntry(entry) {
  const status = entry.status ?? entry.resultStatus ?? "unknown"
  const description = compactInline(entry.description ?? entry.prompt ?? "", MAX_COMPACTION_DESCRIPTION_CHARS)
  const parts = [
    `- **${compactInline(nameOf(entry.agent), 80)}**`,
    entry.category ? `[${compactInline(nameOf(entry.category), 60)}]` : "",
    `(${status})`,
    ` task_id: \`${compactInline(entry.id ?? entry.taskId ?? "", 120)}\``,
    description ? `: ${description}` : "",
    entry.sessionID ? ` | session: \`${compactInline(entry.sessionID, 120)}\`` : "",
  ]
  return parts.filter((part) => part.length > 0).join("")
}

function compactInline(value, maxChars) {
  const normalized = String(value ?? "").replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").replace(/`/g, "'").trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  const keepChars = Math.max(0, maxChars - COMPACTION_TRUNCATION_SUFFIX.length)
  return `${normalized.slice(0, keepChars).trimEnd()}${COMPACTION_TRUNCATION_SUFFIX}`
}

function appendWithinBudget(lines, line, maxChars) {
  const currentLength = joinedLength(lines)
  const separatorLength = lines.length === 0 ? 0 : 1
  if (currentLength + separatorLength + line.length > maxChars) {
    return false
  }
  lines.push(line)
  return true
}

function appendBudgetSummary(lines, omittedCount) {
  const summary = compactionOmittedSummary(omittedCount)
  if (appendWithinBudget(lines, summary, MAX_COMPACTION_TOTAL_CHARS)) {
    return
  }
  while (lines.length > 0 && !appendWithinBudget(lines, summary, MAX_COMPACTION_TOTAL_CHARS)) {
    lines.pop()
  }
}

function joinedLength(lines) {
  return lines.reduce((total, line, index) => total + line.length + (index === 0 ? 0 : 1), 0)
}

function defaultReport(error, context) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[oh-my-rigel] Native V2 background manager: session=${context?.sessionID ?? "unknown"}; phase=${context?.phase ?? "unknown"}; ${message}`)
}

function modelRefOf(record) {
  return record?.modelRef && typeof record.modelRef === "object" ? record.modelRef : undefined
}

/**
 * Create an independent background-child manager.
 *
 * Options:
 *  - `directory`   project directory for the durable state + continuation marker.
 *  - `config`      background-task concurrency config.
 *  - `startChild`  required `async (descriptor, onSession) => { sessionID, model? }`.
 *                  `onSession(sessionID, model)` MUST be called as soon as the
 *                  child session exists (before the prompt) so the binding is
 *                  race-free. Called for the first admitted descriptor and for
 *                  every descriptor promoted from the queue.
 *  - `runHandoff`  `async ({ sessionID, status, child }) => void`.
 *  - `abortChild`  `(sessionID) => void | Promise<void>` for a running cancel.
 *  - `onError`     `(error, { sessionID, phase }) => void` reporter.
 *  - `abortSignal` optional signal; aborting it disposes the manager.
 *  - `now`         optional `() => string` timestamp seam.
 *  - `idFactory`   optional `() => string` task-id seam.
 */
export function createBackgroundManager({
  directory,
  config,
  startChild,
  runHandoff,
  abortChild,
  onError,
  abortSignal,
  now,
  idFactory,
  stateStore,
} = {}) {
  const report = typeof onError === "function" ? onError : defaultReport
  const makeId = typeof idFactory === "function" ? idFactory : () => `bg_${randomUUID()}`
  // The durable-state contract. The runtime injects the official `ctx.storage`
  // adapter; tests inject a deterministic file/in-memory store; the default is a
  // no-op so an in-memory-only manager never touches disk.
  const store = stateStore ?? createNoopBackgroundState()
  // Per-parent serialized persistence: every write/clear for a parent runs in
  // order through ONE promise chain, so an older snapshot can never overwrite a
  // newer one. A generation guard stops a stale write from resurrecting a parent
  // that was intentionally cleared. `flush()` awaits every chain.
  const parentOps = new Map()
  function opEntry(parentSessionID) {
    let entry = parentOps.get(parentSessionID)
    if (!entry) {
      entry = { chain: Promise.resolve(), generation: 0, clearedAt: -1 }
      parentOps.set(parentSessionID, entry)
    }
    return entry
  }
  function enqueueOp(parentSessionID, op) {
    const entry = opEntry(parentSessionID)
    entry.chain = entry.chain.then(op).catch((error) => report(error, { sessionID: parentSessionID, phase: "persist" }))
    return entry.chain
  }
  function writeState(parentSessionID) {
    const entry = opEntry(parentSessionID)
    const generation = ++entry.generation
    const snapshot = { tasks: snapshotTasks(parentSessionID), wakes: snapshotWakes(parentSessionID) }
    return enqueueOp(parentSessionID, async () => {
      if (generation <= entry.clearedAt) return
      await store.write(parentSessionID, snapshot)
    })
  }
  function clearState(parentSessionID) {
    const entry = opEntry(parentSessionID)
    entry.clearedAt = entry.generation
    return enqueueOp(parentSessionID, () => store.clear(parentSessionID))
  }
  /** Await every pending per-parent write/clear so persistence has total order. */
  function flush() {
    return Promise.all([...parentOps.values()].map((entry) => entry.chain)).then(() => undefined)
  }
  const tasks = new Map()
  const bySession = new Map()
  const queue = createBackgroundQueue(config)
  let disposed = false
  // During `restore`, snapshot writes must wait until every parent's state is in
  // memory, or an early promoted start would persist a half-restored snapshot.
  let restoring = false
  const restoringParents = new Set()

  function timestamp() {
    return typeof now === "function" ? now() : new Date().toISOString()
  }

  function tasksOf(parentSessionID) {
    const matched = []
    for (const record of tasks.values()) {
      if (record.parentSessionID === parentSessionID) matched.push(record)
    }
    return matched
  }

  function snapshotTasks(parentSessionID) {
    return tasksOf(parentSessionID).map((record) => ({
      taskId: record.taskId,
      status: record.status,
      route: record.route,
      agent: record.agent,
      category: record.category?.name ?? null,
      subagentType: record.subagentType ?? null,
      model: record.modelKey ?? null,
      modelRef: modelRefOf(record) ?? null,
      resumeSessionID: record.resumeSessionID ?? null,
      key: record.key,
      limit: record.limit,
      sessionID: record.sessionID ?? null,
      // A child that owns the work carries its own prompt; only unstarted
      // descriptors (queued / starting) need the prompt to be restartable.
      prompt: record.status === "queued" || record.status === "starting" ? (record.prompt ?? null) : null,
      loadSkills: Array.isArray(record.loadSkills) ? record.loadSkills : [],
      createdAt: record.createdAt,
    }))
  }

  function snapshotWakes(parentSessionID) {
    return tasksOf(parentSessionID)
      .filter((record) => record.pendingWake)
      .map((record) => ({ taskId: record.taskId, sessionID: record.sessionID ?? null, status: record.resultStatus ?? null, agent: record.agent }))
  }

  /** Persist the durable state and refresh the continuation marker. */
  function persist(parentSessionID) {
    if (typeof parentSessionID !== "string" || parentSessionID.length === 0) return
    // Marker refresh is cheap and always safe; the state file waits for restore
    // to finish so it never records a half-restored parent.
    if (restoring) {
      restoringParents.add(parentSessionID)
    } else {
      writeState(parentSessionID)
    }
    refreshMarker(parentSessionID)
  }

  /** Rewrite the parent's continuation marker from the live task table. */
  function refreshMarker(parentSessionID) {
    if (typeof parentSessionID !== "string" || parentSessionID.length === 0) return
    let activeTaskCount = 0
    let hasUndeliveredParentWake = false
    for (const record of tasksOf(parentSessionID)) {
      if (record.status === "running" || record.status === "queued" || record.status === "starting" || record.status === "cancelling") activeTaskCount += 1
      if (record.pendingWake) hasUndeliveredParentWake = true
    }
    writeBackgroundMarker({ directory, parentSessionID, activeTaskCount, hasUndeliveredParentWake }, now)
  }

  function bindSession(taskId, sessionID, childModel) {
    const record = tasks.get(taskId)
    if (!record || typeof sessionID !== "string" || sessionID.length === 0) return false
    record.sessionID = sessionID
    bySession.set(sessionID, taskId)
    if (childModel && typeof childModel === "object") record.effectiveModel = childModel
    if (record.status === "cancelling") {
      // The cancel won the race against session creation: abort the fresh child
      // and release the slot so the next queued descriptor starts.
      if (typeof abortChild === "function") {
        try {
          const pending = abortChild(sessionID)
          if (pending && typeof pending.then === "function") pending.catch((error) => report(error, { sessionID, phase: "abort" }))
        } catch (error) {
          report(error, { sessionID, phase: "abort" })
        }
      }
      detachFromQueue(record)
      tasks.delete(taskId)
      bySession.delete(sessionID)
      persist(record.parentSessionID)
      return false
    }
    record.status = "running"
    record.prompt = undefined
    persist(record.parentSessionID)
    return true
  }

  function failStart(taskId, error) {
    const record = tasks.get(taskId)
    if (!record) return
    detachFromQueue(record)
    if (record.sessionID) bySession.delete(record.sessionID)
    tasks.delete(taskId)
    persist(record.parentSessionID)
    report(error, { sessionID: record.sessionID, phase: "start" })
  }

  /** Start a record through the injected spawner. Returns a promise that rejects on failure. */
  function launch(record) {
    if (typeof startChild !== "function") {
      return Promise.reject(new Error("background manager: startChild is not configured"))
    }
    return (async () => {
      try {
        const result = await startChild(record, (sessionID, childModel) => bindSession(record.taskId, sessionID, childModel))
        if (record.status !== "cancelling" && !record.sessionID && typeof result?.sessionID === "string") {
          bindSession(record.taskId, result.sessionID, result.model)
        }
        return { sessionID: record.sessionID }
      } catch (error) {
        failStart(record.taskId, error)
        throw error
      }
    })()
  }

  function releaseSlot(record) {
    if (!record.slotHeld) return null
    record.slotHeld = false
    const result = queue.release(record.key)
    const grantedTaskId = result?.granted?.taskId
    if (grantedTaskId) {
      const next = tasks.get(grantedTaskId)
      if (next && next.status === "queued") {
        next.status = "starting"
        next.slotHeld = true
        persist(next.parentSessionID)
        launch(next).catch(() => {})
      }
    }
    return result
  }

  /** Remove a tracked record from its concurrency bucket, whatever its state. */
  function detachFromQueue(record) {
    if (record.slotHeld) return releaseSlot(record)
    queue.cancelWaiter(record.key, record.taskId)
    return null
  }

  const pump = createHandoffPump({
    run: (item) => (typeof runHandoff === "function"
      ? runHandoff({ sessionID: item.sessionID, status: item.status, child: item.child })
      : undefined),
    onDelivered: (item) => {
      const taskId = bySession.get(item.sessionID)
      const record = taskId ? tasks.get(taskId) : undefined
      if (!record) return
      tasks.delete(taskId)
      bySession.delete(item.sessionID)
      persist(record.parentSessionID)
    },
    onFailed: (item, error) => {
      const taskId = bySession.get(item.sessionID)
      const record = taskId ? tasks.get(taskId) : undefined
      if (record) record.pendingWake = true
      report(error, { sessionID: item.sessionID, phase: "handoff" })
    },
    onExhausted: (item, error) => {
      const taskId = bySession.get(item.sessionID)
      const record = taskId ? tasks.get(taskId) : undefined
      if (record) {
        tasks.delete(taskId)
        bySession.delete(item.sessionID)
        persist(record.parentSessionID)
      }
      report(error, { sessionID: item.sessionID, phase: "handoff-exhausted" })
    },
    onError: (error, item) => report(error, { sessionID: item?.sessionID, phase: "handoff-callback" }),
  })

  /**
   * Admit a background request BEFORE it starts. Returns
   * `{ admitted, queued, taskId, key, limit, ready? }`. Only an admitted request
   * has a `ready` promise; a queued request starts nothing until a slot frees.
   */
  function admit(descriptor) {
    if (disposed) return { admitted: false, queued: false, taskId: null, reason: "disposed" }
    const parentSessionID = descriptor?.parentSessionID
    if (typeof parentSessionID !== "string" || parentSessionID.length === 0) {
      return { admitted: false, queued: false, taskId: null, reason: "no-parent" }
    }
    const taskId = typeof descriptor.taskId === "string" && descriptor.taskId.length > 0 ? descriptor.taskId : makeId()
    const existing = tasks.get(taskId)
    if (existing) {
      return { admitted: existing.status === "running" || existing.status === "starting", queued: existing.status === "queued", taskId, key: existing.key, limit: existing.limit, reason: "already-tracked" }
    }
    const modelKey = typeof descriptor.modelKey === "string" ? descriptor.modelKey : ""
    const decision = queue.enqueue(modelKey, taskId)
    const record = {
      taskId,
      parentSessionID,
      route: descriptor.route ?? "subagent",
      agent: descriptor.agent,
      category: descriptor.category,
      subagentType: descriptor.subagentType,
      modelRef: descriptor.model,
      modelKey,
      resumeSessionID: typeof descriptor.resumeSessionID === "string" ? descriptor.resumeSessionID : undefined,
      prompt: descriptor.prompt,
      loadSkills: descriptor.loadSkills,
      key: decision.key,
      limit: decision.limit,
      status: decision.admitted ? "starting" : "queued",
      slotHeld: decision.admitted,
      sessionID: undefined,
      effectiveModel: undefined,
      pendingWake: false,
      resultStatus: undefined,
      createdAt: timestamp(),
    }
    tasks.set(taskId, record)
    persist(parentSessionID)
    if (!decision.admitted) {
      return { admitted: false, queued: true, taskId, key: decision.key, limit: decision.limit }
    }
    const ready = launch(record)
    return { admitted: true, queued: false, taskId, key: decision.key, limit: decision.limit, ready }
  }

  /**
   * Queue a parent-wake handoff for a tracked child. Returns synchronously: the
   * pump runs behind a microtask, so the V2 event loop is never blocked.
   */
  function enqueueHandoff(sessionID, status) {
    if (disposed) return false
    const taskId = bySession.get(sessionID)
    const record = taskId ? tasks.get(taskId) : undefined
    if (!record) return false
    record.status = "completed"
    detachFromQueue(record)
    record.pendingWake = true
    record.resultStatus = status
    pump.enqueue({ sessionID, taskId, status, child: { parentSessionID: record.parentSessionID, agent: record.agent } })
    persist(record.parentSessionID)
    return true
  }

  /** Re-queue every undelivered wake that is not already waiting. */
  function retryPendingWakes() {
    if (disposed) return 0
    let requeued = 0
    for (const record of tasks.values()) {
      if (!record.pendingWake || !record.sessionID || pump.has(record.sessionID)) continue
      pump.enqueue({ sessionID: record.sessionID, taskId: record.taskId, status: record.resultStatus, child: { parentSessionID: record.parentSessionID, agent: record.agent } })
      requeued += 1
    }
    return requeued
  }

  /** Cancel a queued (zero spawn), starting, or running child. */
  function cancel(taskId) {
    const record = tasks.get(taskId)
    if (!record) return { cancelled: false, error: null, mode: "unknown" }
    const parentSessionID = record.parentSessionID
    if (record.status === "queued") {
      const result = queue.cancelWaiter(record.key, taskId)
      tasks.delete(taskId)
      persist(parentSessionID)
      return { cancelled: result.cancelled, error: result.error, mode: "queued" }
    }
    if (record.status === "starting") {
      // The spawn is in flight; `bindSession` aborts the fresh session and
      // releases the slot as soon as it exists. Nothing to abort yet.
      record.status = "cancelling"
      persist(parentSessionID)
      return { cancelled: true, error: null, mode: "starting" }
    }
    pump.remove(record.sessionID)
    detachFromQueue(record)
    if (record.sessionID) bySession.delete(record.sessionID)
    tasks.delete(taskId)
    if (record.sessionID && typeof abortChild === "function") {
      try {
        const pending = abortChild(record.sessionID)
        if (pending && typeof pending.then === "function") pending.catch((error) => report(error, { sessionID: record.sessionID, phase: "abort" }))
      } catch (error) {
        report(error, { sessionID: record.sessionID, phase: "abort" })
      }
    }
    persist(parentSessionID)
    return { cancelled: true, error: null, mode: record.status === "completed" ? "completed" : "running" }
  }

  /**
   * Every task that descends from `parentSessionID`, transitively. A task is a
   * direct child when its `parentSessionID` names the session; once it has a
   * `sessionID` of its own, that id is a parent for the next level (a delegated
   * child that itself delegated). Order is breadth-first from the parent; a
   * task id is returned once even if more than one path reaches it.
   */
  function getAllDescendantTasks(parentSessionID) {
    const descendants = []
    if (typeof parentSessionID !== "string" || parentSessionID.length === 0) return descendants
    const seenTaskIds = new Set()
    const seenSessionIds = new Set([parentSessionID])
    let frontier = [parentSessionID]
    while (frontier.length > 0) {
      const nextFrontier = []
      for (const record of tasks.values()) {
        if (!frontier.includes(record.parentSessionID)) continue
        if (seenTaskIds.has(record.taskId)) continue
        seenTaskIds.add(record.taskId)
        descendants.push(record)
        if (typeof record.sessionID === "string" && record.sessionID.length > 0 && !seenSessionIds.has(record.sessionID)) {
          seenSessionIds.add(record.sessionID)
          nextFrontier.push(record.sessionID)
        }
      }
      frontier = nextFrontier
    }
    return descendants
  }

  /**
   * Cancel every queued / starting / running descendant of `parentSessionID`
   * through the internal `cancel(taskId)`, so `/stop-continuation` stops the
   * session's background work without clearing the parent's durable state
   * (`clearParent` is reserved for a DELETED parent). Returns one
   * `{ taskId, cancelled, mode }` per cancellable descendant.
   *
   * `options` mirrors the V1 owner's `cancelTask` call shape (`source`,
   * `reason`, `skipNotification`); this manager's `cancel` has no notification
   * seam, so the options are accepted for interface parity and not forwarded.
   */
  function cancelDescendants(parentSessionID, options = {}) {
    void options
    const cancellable = getAllDescendantTasks(parentSessionID).filter((record) => (
      record.status === "queued" || record.status === "starting" || record.status === "running"
    ))
    // Withdraw the not-yet-started descendants first. Cancelling a running child
    // releases its slot, which would synchronously promote a queued sibling to
    // `running` before this loop reaches it; draining the queue-holders first
    // keeps each descendant cancelled in the state it was found in.
    const priority = { queued: 0, starting: 1, running: 2 }
    cancellable.sort((left, right) => priority[left.status] - priority[right.status])
    const results = []
    for (const record of cancellable) {
      const outcome = cancel(record.taskId)
      results.push({ taskId: record.taskId, cancelled: outcome.cancelled, mode: outcome.mode })
    }
    return results
  }

  /** Drop a session's background state (session.deleted fan-out for a child). */
  function clearSession(sessionID) {
    const taskId = bySession.get(sessionID)
    if (!taskId) return false
    const record = tasks.get(taskId)
    detachFromQueue(record)
    tasks.delete(taskId)
    bySession.delete(sessionID)
    pump.remove(sessionID)
    clearBackgroundMarker(directory, sessionID)
    persist(record.parentSessionID)
    return true
  }

  /**
   * Drop every queued/active child of a PARENT session. A deleted parent can
   * never wake, so its queued descriptors (which have no session id) must be
   * withdrawn before any creation, and its running children must be aborted.
   */
  function clearParent(parentSessionID) {
    const owned = tasksOf(parentSessionID)
    let removed = 0
    for (const record of owned) {
      if (record.status === "queued") {
        queue.cancelWaiter(record.key, record.taskId)
        tasks.delete(record.taskId)
        removed += 1
      }
    }
    for (const record of owned) {
      if (!tasks.has(record.taskId)) continue
      if (record.slotHeld) releaseSlot(record)
      if (record.sessionID) {
        bySession.delete(record.sessionID)
        pump.remove(record.sessionID)
        if (typeof abortChild === "function") {
          try {
            const pending = abortChild(record.sessionID)
            if (pending && typeof pending.then === "function") pending.catch((error) => report(error, { sessionID: record.sessionID, phase: "abort" }))
          } catch (error) {
            report(error, { sessionID: record.sessionID, phase: "abort" })
          }
        }
      }
      tasks.delete(record.taskId)
      removed += 1
    }
    clearBackgroundMarker(directory, parentSessionID)
    clearState(parentSessionID)
    return removed
  }

  /** Drop every tracked child, release every slot, and remove every marker/state file. */
  function clearAll() {
    const parents = new Set()
    for (const record of tasks.values()) {
      if (typeof record.parentSessionID === "string" && record.parentSessionID) parents.add(record.parentSessionID)
      clearBackgroundMarker(directory, record.sessionID)
    }
    tasks.clear()
    bySession.clear()
    queue.clear()
    pump.clear()
    for (const parentSessionID of parents) {
      clearBackgroundMarker(directory, parentSessionID)
      clearState(parentSessionID)
    }
  }

  /**
   * Local shutdown: flush pending persistence, stop the handoff pump, and mark
   * the manager disposed. It does NOT delete durable state or markers, so a clean
   * plugin reload/unload lets the next instance `restore()` the queue, active
   * children, and wakes. Intentional deletion is `clearParent` (session.deleted),
   * `cancel` (terminal), and `clearAll` (explicit teardown).
   */
  async function dispose() {
    disposed = true
    await flush()
    pump.dispose()
  }

  function recordFromState(task, parentSessionID) {
    return {
      taskId: task.taskId,
      parentSessionID,
      route: task.route ?? "subagent",
      agent: task.agent,
      category: task.category ? { name: task.category } : undefined,
      subagentType: task.subagentType ?? undefined,
      modelRef: task.modelRef ?? undefined,
      modelKey: typeof task.model === "string" ? task.model : "",
      resumeSessionID: typeof task.resumeSessionID === "string" ? task.resumeSessionID : undefined,
      prompt: task.prompt ?? undefined,
      loadSkills: Array.isArray(task.loadSkills) ? task.loadSkills : [],
      key: task.key,
      limit: task.limit,
      status: "queued",
      slotHeld: false,
      sessionID: undefined,
      effectiveModel: undefined,
      pendingWake: false,
      resultStatus: undefined,
      createdAt: task.createdAt ?? timestamp(),
    }
  }

  /**
   * Re-admit a persisted descriptor as a REAL FIFO waiter. Unlike `admit`, this
   * never starts the child on the spot: the restored waiter is granted a slot
   * only when one frees, so a restart resumes the queue instead of bypassing the
   * concurrency limit. Returns `{ admitted, queued, taskId, key, limit }`.
   */
  function requeue(descriptor) {
    if (disposed) return { admitted: false, queued: false, taskId: null, reason: "disposed" }
    const parentSessionID = descriptor?.parentSessionID
    if (typeof parentSessionID !== "string" || parentSessionID.length === 0) {
      return { admitted: false, queued: false, taskId: null, reason: "no-parent" }
    }
    const taskId = typeof descriptor.taskId === "string" && descriptor.taskId.length > 0 ? descriptor.taskId : makeId()
    if (tasks.has(taskId)) return { admitted: false, queued: tasks.get(taskId).status === "queued", taskId, reason: "already-tracked" }
    const modelKey = typeof descriptor.modelKey === "string" ? descriptor.modelKey : ""
    const decision = queue.enqueue(modelKey, taskId)
    const record = {
      taskId,
      parentSessionID,
      route: descriptor.route ?? "subagent",
      agent: descriptor.agent,
      category: descriptor.category,
      subagentType: descriptor.subagentType,
      modelRef: descriptor.model,
      modelKey,
      resumeSessionID: typeof descriptor.resumeSessionID === "string" ? descriptor.resumeSessionID : undefined,
      prompt: descriptor.prompt,
      loadSkills: descriptor.loadSkills,
      key: decision.key,
      limit: decision.limit,
      status: decision.admitted ? "starting" : "queued",
      slotHeld: decision.admitted,
      sessionID: undefined,
      effectiveModel: undefined,
      pendingWake: false,
      resultStatus: undefined,
      createdAt: timestamp(),
    }
    tasks.set(taskId, record)
    if (decision.admitted) launch(record).catch(() => {})
    return { admitted: decision.admitted, queued: decision.queued, taskId, key: decision.key, limit: decision.limit }
  }

  /**
   * Reconcile durable state written by a previous process:
   *  - queued descriptors are re-admitted (they never started, so starting them
   *    is exactly-once);
   *  - running children are re-tracked WITHOUT re-creating them;
   *  - an interrupted `starting` descriptor is bound to the already-created child
   *    when `findStartedChild` can identify it (by task id nonce), else it is
   *    re-admitted once;
   *  - undelivered wakes are re-enqueued.
   * Returns a summary for the caller/tests.
   */
  async function restore({ findStartedChild } = {}) {
    const summary = { parents: 0, queued: 0, starting: 0, running: 0, bound: 0, wakes: 0 }
    // A promoted start must not be persisted while another parent's restoration
    // is still in progress (persist rewrites the whole per-parent snapshot).
    restoring = true
    try {
      const parents = await store.list()
      for (const parentSessionID of parents) {
        const state = await store.read(parentSessionID)
        if (!state) continue
        summary.parents += 1
        for (const task of state.tasks) {
          if (task.status === "running" && typeof task.sessionID === "string") {
            const record = recordFromState(task, parentSessionID)
            record.status = "running"
            record.slotHeld = true
            record.sessionID = task.sessionID
            tasks.set(record.taskId, record)
            bySession.set(task.sessionID, record.taskId)
            queue.enqueue(record.modelKey, record.taskId)
            summary.running += 1
          } else if (task.status === "starting") {
            const found = typeof findStartedChild === "function" ? await findStartedChild(task) : undefined
            if (found && typeof found.sessionID === "string") {
              const record = recordFromState(task, parentSessionID)
              record.status = "running"
              record.slotHeld = true
              record.sessionID = found.sessionID
              tasks.set(record.taskId, record)
              bySession.set(found.sessionID, record.taskId)
              queue.enqueue(record.modelKey, record.taskId)
              summary.bound += 1
            } else {
              requeue(recordFromState(task, parentSessionID))
              summary.starting += 1
            }
          } else if (task.status === "queued") {
            requeue(recordFromState(task, parentSessionID))
            summary.queued += 1
          }
        }
        for (const wake of state.wakes) {
          const taskId = typeof wake.taskId === "string" ? wake.taskId : (typeof wake.sessionID === "string" ? bySession.get(wake.sessionID) : undefined)
          const record = taskId ? tasks.get(taskId) : undefined
          if (!record || !record.sessionID || pump.has(record.sessionID)) continue
          record.pendingWake = true
          record.resultStatus = record.resultStatus ?? wake.status ?? "succeeded"
          pump.enqueue({ sessionID: record.sessionID, taskId: record.taskId, status: record.resultStatus, child: { parentSessionID: record.parentSessionID, agent: record.agent } })
          summary.wakes += 1
        }
        persist(parentSessionID)
      }
    } finally {
      restoring = false
      for (const parentSessionID of restoringParents) {
        writeState(parentSessionID)
      }
      restoringParents.clear()
    }
    return summary
  }

  function has(sessionID) {
    return bySession.has(sessionID)
  }

  function getTask(taskId) {
    const record = tasks.get(taskId)
    return record ? { ...record } : undefined
  }

  function getChild(sessionID) {
    const taskId = bySession.get(sessionID)
    const record = taskId ? tasks.get(taskId) : undefined
    return record ? { ...record } : undefined
  }

  function activeCount(parentSessionID) {
    return tasksOf(parentSessionID).filter((record) => record.status === "running" || record.status === "queued" || record.status === "starting").length
  }

  function runningCount(parentSessionID) {
    return tasksOf(parentSessionID).filter((record) => record.status === "running").length
  }

  function pendingWakeCount(parentSessionID) {
    return tasksOf(parentSessionID).filter((record) => record.pendingWake).length
  }

  function queueStats(key) {
    return { count: queue.getCount(key), queued: queue.getQueueLength(key) }
  }

  function whenIdle() {
    return pump.whenIdle()
  }

  function classifyRetry(input) {
    return decideBackgroundRetry(input)
  }

  /**
   * Bounded, read-only compaction summary of a parent's delegated sessions for
   * the T21 "Active/Recent Delegated Sessions" context section. Each tracked
   * record is mapped to a compaction entry (task id, agent, category, status,
   * session, prompt-derived description) and the bounded formatting is delegated
   * to `formatCompactionHistory`. Status falls back to the record's
   * `resultStatus` when no live status is present. Returns null when the parent
   * has no records. It never mutates queue or task state.
   */
  function formatForCompaction(parentSessionID) {
    const records = tasksOf(parentSessionID)
    if (records.length === 0) return null
    return formatCompactionHistory(
      records.map((record) => ({
        id: record.taskId,
        agent: record.agent,
        category: record.category,
        status: record.status ?? record.resultStatus,
        resultStatus: record.resultStatus,
        sessionID: record.sessionID,
        description: record.prompt,
      })),
    )
  }

  if (abortSignal && typeof abortSignal.addEventListener === "function") {
    abortSignal.addEventListener("abort", dispose, { once: true })
  }

  return {
    admit,
    cancel,
    getAllDescendantTasks,
    cancelDescendants,
    enqueueHandoff,
    retryPendingWakes,
    clearSession,
    clearParent,
    clearAll,
    dispose,
    flush,
    restore,
    has,
    getTask,
    getChild,
    activeCount,
    runningCount,
    pendingWakeCount,
    queueStats,
    refreshMarker,
    persist,
    whenIdle,
    classifyRetry,
    formatForCompaction,
  }
}
