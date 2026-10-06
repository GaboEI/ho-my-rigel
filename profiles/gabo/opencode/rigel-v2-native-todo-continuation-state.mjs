/**
 * Per-session todo-continuation state store for Oh My Rigel's native OpenCode V2
 * runtime.
 *
 * Direct port of the V1 `todo-continuation-enforcer/session-state.ts`
 * `createSessionStateStore()`: the per-session progress/stagnation bookkeeping
 * the boulder hook reads on every `session.idle`. The continuation handler in
 * the V2 runtime owns the decision gate; this module owns only the state and
 * the progress semantics, so it is pure, dependency-free, and testable in
 * isolation.
 *
 * The one subtle rule (issue #4013 P0.2): meaningful progress is a smaller
 * incomplete count, a larger completed count, or a changed `{id -> status}`
 * snapshot. A todo that keeps its id but changes its `content` or `priority`
 * is NOT progress and must not reset the stagnation counter.
 *
 * Pure module: no imports, no runtime dependencies, no I/O.
 */

export const MAX_STAGNATION_COUNT = 3
export const MAX_CONSECUTIVE_FAILURES = 5
export const FAILURE_RESET_WINDOW_MS = 5 * 60 * 1000
export const CONTINUATION_COOLDOWN_MS = 5000
export const COMPACTION_GUARD_MS = 60000
export const ABORT_WINDOW_MS = 3000
export const COUNTDOWN_SECONDS = 2

const SESSION_STATE_TTL_MS = 10 * 60 * 1000
const SESSION_STATE_PRUNE_INTERVAL_MS = 2 * 60 * 1000

/**
 * Build the compare-only snapshot described above: a sorted list of
 * `id=status` (or `content:priority=status` when a todo has no id). Content and
 * priority are part of the fallback key only, never part of the value, so a
 * metadata-only edit leaves the snapshot unchanged.
 */
export function getTodoSnapshot(todos) {
  const entries = todos
    .map((todo) => ({
      key: todo.id ?? `${todo.content}:${todo.priority}`,
      status: todo.status,
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, status }) => `${key}=${status}`)

  return entries.join("|")
}

function createInitialState() {
  return {
    stagnationCount: 0,
    consecutiveFailures: 0,
    countdownTimer: undefined,
    countdownInterval: undefined,
    isRecovering: false,
    wasCancelled: false,
    tokenLimitDetected: false,
    unrecoverableErrorDetected: false,
    countdownStartedAt: undefined,
    abortDetectedAt: undefined,
    lastIncompleteCount: undefined,
    lastInjectedAt: undefined,
    awaitingPostInjectionProgressCheck: false,
    continuationResponseObserved: false,
    continuationBlockReason: undefined,
    pendingUserMessageID: undefined,
    inFlight: false,
    allTodosCompletedAt: undefined,
    recentCompactionAt: undefined,
    recentCompactionEpoch: undefined,
    acknowledgedCompactionEpoch: undefined,
  }
}

/**
 * Create an independent per-session store. Each session gets its own state plus
 * the last completed count / todo snapshot the progress comparison needs (kept
 * beside the state rather than inside it so consumers can read a stable shape).
 *
 * The returned object mirrors the V1 store surface, plus `startPruneInterval`
 * for parity with the V1 TTL sweep.
 */
export function createNativeTodoContinuationState() {
  const sessions = new Map()

  let pruneInterval
  let pruneIntervalStarted = false

  function startPruneInterval() {
    if (pruneIntervalStarted) return
    pruneIntervalStarted = true
    pruneInterval = setInterval(() => {
      const now = Date.now()
      for (const [sessionID, tracked] of sessions.entries()) {
        if (now - tracked.lastAccessedAt > SESSION_STATE_TTL_MS) {
          cancelCountdown(sessionID)
          sessions.delete(sessionID)
        }
      }
    }, SESSION_STATE_PRUNE_INTERVAL_MS)
    if (pruneInterval && typeof pruneInterval.unref === "function") {
      pruneInterval.unref()
    }
  }

  function getTrackedSession(sessionID) {
    const existing = sessions.get(sessionID)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      return existing
    }

    const trackedSession = {
      state: createInitialState(),
      lastAccessedAt: Date.now(),
      lastCompletedCount: undefined,
      lastTodoSnapshot: undefined,
    }
    sessions.set(sessionID, trackedSession)
    return trackedSession
  }

  function getState(sessionID) {
    return getTrackedSession(sessionID).state
  }

  function getExistingState(sessionID) {
    const existing = sessions.get(sessionID)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      return existing.state
    }
    return undefined
  }

  function trackContinuationProgress(sessionID, incompleteCount, todos) {
    const trackedSession = getTrackedSession(sessionID)
    const state = trackedSession.state
    const previousIncompleteCount = state.lastIncompleteCount
    const previousStagnationCount = state.stagnationCount
    const currentCompletedCount = todos
      ? todos.filter((todo) => todo.status === "completed").length
      : undefined
    const currentTodoSnapshot = todos ? getTodoSnapshot(todos) : undefined
    const hasCompletedMoreTodos =
      currentCompletedCount !== undefined
      && trackedSession.lastCompletedCount !== undefined
      && currentCompletedCount > trackedSession.lastCompletedCount
    const hasTodoSnapshotChanged =
      currentTodoSnapshot !== undefined
      && trackedSession.lastTodoSnapshot !== undefined
      && currentTodoSnapshot !== trackedSession.lastTodoSnapshot
    const hadSuccessfulInjectionAwaitingProgressCheck =
      state.awaitingPostInjectionProgressCheck === true

    state.lastIncompleteCount = incompleteCount
    if (currentCompletedCount !== undefined) {
      trackedSession.lastCompletedCount = currentCompletedCount
    }
    if (currentTodoSnapshot !== undefined) {
      trackedSession.lastTodoSnapshot = currentTodoSnapshot
    }

    if (previousIncompleteCount === undefined) {
      state.stagnationCount = 0
      return {
        previousIncompleteCount,
        previousStagnationCount,
        stagnationCount: state.stagnationCount,
        hasProgressed: false,
        progressSource: "none",
      }
    }

    const hasProgressed =
      incompleteCount < previousIncompleteCount
      || hasCompletedMoreTodos
      || hasTodoSnapshotChanged

    if (hasProgressed) {
      state.stagnationCount = 0
      state.awaitingPostInjectionProgressCheck = false
      state.continuationResponseObserved = false
      state.continuationBlockReason = undefined
      state.pendingUserMessageID = undefined
      return {
        previousIncompleteCount,
        previousStagnationCount,
        stagnationCount: state.stagnationCount,
        hasProgressed: true,
        progressSource: "todo",
      }
    }

    if (!hadSuccessfulInjectionAwaitingProgressCheck) {
      return {
        previousIncompleteCount,
        previousStagnationCount,
        stagnationCount: state.stagnationCount,
        hasProgressed: false,
        progressSource: "none",
      }
    }

    state.awaitingPostInjectionProgressCheck = false
    if (
      state.continuationResponseObserved === true
      && state.continuationBlockReason !== "user-interruption"
    ) {
      state.continuationBlockReason = "directive-response"
    }
    state.continuationResponseObserved = false
    state.pendingUserMessageID = undefined
    state.stagnationCount += 1
    return {
      previousIncompleteCount,
      previousStagnationCount,
      stagnationCount: state.stagnationCount,
      hasProgressed: false,
      progressSource: "none",
    }
  }

  function resetContinuationProgress(sessionID) {
    const trackedSession = sessions.get(sessionID)
    if (!trackedSession) return

    trackedSession.lastAccessedAt = Date.now()

    const { state } = trackedSession

    state.lastIncompleteCount = undefined
    state.stagnationCount = 0
    state.awaitingPostInjectionProgressCheck = false
    state.continuationResponseObserved = false
    state.continuationBlockReason = undefined
    state.pendingUserMessageID = undefined
    state.allTodosCompletedAt = undefined
    trackedSession.lastCompletedCount = undefined
    trackedSession.lastTodoSnapshot = undefined
  }

  function cancelCountdown(sessionID) {
    const tracked = sessions.get(sessionID)
    if (!tracked) return

    const { state } = tracked
    if (state.countdownTimer) {
      clearTimeout(state.countdownTimer)
      state.countdownTimer = undefined
    }

    if (state.countdownInterval) {
      clearInterval(state.countdownInterval)
      state.countdownInterval = undefined
    }

    state.inFlight = false
    state.countdownStartedAt = undefined
  }

  function cleanup(sessionID) {
    cancelCountdown(sessionID)
    sessions.delete(sessionID)
  }

  function cancelAllCountdowns() {
    for (const sessionID of sessions.keys()) {
      cancelCountdown(sessionID)
    }
  }

  function shutdown() {
    if (pruneInterval !== undefined) {
      clearInterval(pruneInterval)
      pruneInterval = undefined
      pruneIntervalStarted = false
    }
    cancelAllCountdowns()
    sessions.clear()
  }

  return {
    getState,
    getExistingState,
    startPruneInterval,
    trackContinuationProgress,
    resetContinuationProgress,
    cancelCountdown,
    cleanup,
    cancelAllCountdowns,
    shutdown,
  }
}
