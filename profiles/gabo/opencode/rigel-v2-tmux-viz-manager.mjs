/**
 * Native V2 tmux visualization manager (rewrite of V1
 * `features/tmux-subagent/manager.ts`).
 *
 * Owns the lifecycle of one agent pane per delegated session:
 * - `onSessionCreated`: gate -> readiness wait (10s) -> spawn (split of the
 *   source pane, or an isolated window/session container) -> track -> poll.
 *   Failures re-queue the session in a deferred queue (cap 20, TTL 5min) and
 *   close any pane created by the failed attempt.
 * - `onSessionDeleted`: close the tracked pane (C-c then kill-pane, tolerant
 *   of an already-gone pane) with bounded retries.
 * - `onEvent`: message activity feeds the polling stability checks.
 * - `cleanup()`: close everything and tear down an isolated session.
 * - One-shot zombie sweep on the first session.created.
 *
 * Every degraded decision is logged with its exact reason.
 */

import { detectTmuxVizEnvironment } from "./rigel-v2-tmux-viz-env.mjs"
import { createTmuxVizRunner, createServerHealthProbe } from "./rigel-v2-tmux-viz-runner.mjs"
import { queryWindowState } from "./rigel-v2-tmux-viz-pane-state.mjs"
import {
  buildPlaceholderCommand, buildSpawnArgs, buildReplaceArgs, buildTitleArgs,
  buildApplyLayoutArgs, buildResizeArgs, decideSpawnActions, computeMainPaneWidth,
} from "./rigel-v2-tmux-viz-layout.mjs"
import { createTmuxVizPolling, POLL_INTERVAL_BACKGROUND_MS } from "./rigel-v2-tmux-viz-polling.mjs"
import { closeTmuxPane, sweepStaleTmuxResources, MAX_CLOSE_RETRY_COUNT, CLOSE_RETRY_COOLDOWN_MS } from "./rigel-v2-tmux-viz-cleanup.mjs"

export const MAX_DEFERRED_QUEUE_SIZE = 20
export const DEFERRED_SESSION_TTL_MS = 5 * 60 * 1000
export const SESSION_READY_POLL_MS = 500
export const SESSION_READY_TIMEOUT_MS = 10 * 1000
const ATTACHABLE_STATUSES = new Set(["idle", "running", "busy", "retry"])

export function createTmuxVizManager({
  config = {},
  env = process.env,
  serverUrl,
  directory = process.cwd(),
  fetchSessionStatus,
  shouldSkipSession = () => false,
  managerPid = process.pid,
  healthMarker = globalThis,
  logger = console.error,
  spawnImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const environment = detectTmuxVizEnvironment({ env })
  const resolved = {
    layout: config.layout ?? "main-vertical",
    mainPaneSize: config.main_pane_size ?? 60,
    mainPaneMinWidth: config.main_pane_min_width ?? 120,
    agentPaneMinWidth: config.agent_pane_min_width ?? 40,
    isolation: config.isolation ?? "inline",
  }
  const enabled = environment.degradedReason === null
  const health = createServerHealthProbe({ marker: healthMarker })
  // V1 parity: the plugin instance knows the server it lives in, so the
  // health probe can trust the in-process marker instead of probing itself.
  if (serverUrl) health.markServerRunningInProcess()
  const runner = enabled ? createTmuxVizRunner({ tmuxPath: environment.tmuxPath, spawnImpl }) : null
  const sessions = new Map()
  const pendingSessions = new Set()
  const deferredSessions = []
  const spawnQueue = []
  let drainRunning = false
  let deferredLoop = null
  let sweptOnce = false
  let deferredLoopStopped = false

  const log = (line) => logger(`[oh-my-rigel] tmux-viz: ${line}`)

  async function applyLayoutEnforcement() {
    await runner.run(buildApplyLayoutArgs(resolved.layout, resolved.mainPaneSize))
    const state = await queryWindowState({ runner, sourcePaneId: environment.sourcePaneId })
    if (!state) return
    const width = computeMainPaneWidth({
      windowWidth: state.windowWidth,
      mainPaneSize: resolved.mainPaneSize,
      mainPaneMinWidth: resolved.mainPaneMinWidth,
      agentPaneMinWidth: resolved.agentPaneMinWidth,
    })
    await runner.run(buildResizeArgs(state.mainPane.paneId, width))
  }

  async function executeActions(actions) {
    let spawnedPaneId = null
    for (const action of actions) {
      if (action.kind === "close") {
        await closeTmuxPane({ runner, paneId: action.paneId, sleep })
        continue
      }
      if (action.kind === "replace") {
        await runner.run(buildReplaceArgs({ paneId: action.paneId, placeholderCommand: buildPlaceholderCommand("replaced") }))
        await runner.run(buildTitleArgs(action.paneId, "replaced"))
        continue
      }
      const spawnArgs = buildSpawnArgs({
        direction: action.direction,
        targetPaneId: action.targetPaneId,
        placeholderCommand: buildPlaceholderCommand("agent"),
      })
      const result = await runner.run(spawnArgs)
      if (result.exitCode !== 0) return { spawnedPaneId, ok: false, error: result.stderr.trim().slice(0, 200) }
      spawnedPaneId = result.stdout.trim().split("\n").at(-1)
      await runner.run(buildTitleArgs(spawnedPaneId, "agent"))
    }
    return { spawnedPaneId, ok: true, error: null }
  }

  async function spawnInline(description) {
    const state = await queryWindowState({ runner, sourcePaneId: environment.sourcePaneId })
    if (!state) return { ok: false, error: "window state unavailable" }
    const decision = decideSpawnActions({ windowState: state, layout: resolved.layout, mainPaneSize: resolved.mainPaneSize, mainPaneMinWidth: resolved.mainPaneMinWidth, agentPaneMinWidth: resolved.agentPaneMinWidth, sourcePaneId: environment.sourcePaneId })
    if (!decision.canSpawn) return { ok: false, error: decision.reason, deferred: true }
    const execution = await executeActions(decision.actions)
    if (!execution.ok) return { ok: false, error: execution.error }
    await runner.run(buildTitleArgs(execution.spawnedPaneId, description))
    await applyLayoutEnforcement()
    log(`spawned pane ${execution.spawnedPaneId} for session (inline split)`)
    return { ok: true, paneId: execution.spawnedPaneId }
  }

  async function spawnIsolatedContainer(description) {
    const placeholder = buildPlaceholderCommand(description)
    if (resolved.isolation === "window") {
      const result = await runner.run(["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", placeholder])
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.trim().slice(0, 200) }
      return { ok: true, paneId: result.stdout.trim().split("\n").at(-1), isolated: true }
    }
    const sessionName = `omo-agents-${managerPid}`
    const result = await runner.run(["new-session", "-d", "-s", sessionName, "-P", "-F", "#{pane_id}", placeholder])
    if (result.exitCode !== 0) return { ok: false, error: result.stderr.trim().slice(0, 200) }
    return { ok: true, paneId: result.stdout.trim().split("\n").at(-1), isolated: true }
  }

  async function waitForSessionReady(sessionID) {
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const statuses = typeof fetchSessionStatus === "function" ? await fetchSessionStatus() : null
      const status = statuses?.get?.(sessionID)
      if (ATTACHABLE_STATUSES.has(status)) return true
      await sleep(SESSION_READY_POLL_MS)
    }
    return false
  }

  async function spawnPendingSession({ sessionID, description }) {
    const serverAlive = await health.isServerRunning(serverUrl)
    if (!serverAlive) return { ok: false, error: "opencode server is not reachable", deferred: true }
    const ready = await waitForSessionReady(sessionID)
    if (!ready) return { ok: false, error: "session did not reach an attachable status within 10s", deferred: true }
    const result = resolved.isolation === "inline"
      ? await spawnInline(description)
      : await spawnIsolatedContainer(description)
    if (!result.ok) return result
    sessions.set(sessionID, {
      sessionID,
      paneId: result.paneId,
      isolated: Boolean(result.isolated),
      cmux: environment.cmux,
      createdAt: Date.now(),
      activityVersion: 0,
      stablePolls: 0,
      attachActivated: environment.cmux && !result.isolated,
      // Pending-close retry/cooldown state (V1 `TrackedSession` parity):
      // a failed close leaves the session tracked so a later polling pass
      // retries it, and after MAX_CLOSE_RETRY_COUNT failures a cooldown is
      // stamped instead of leaking the pane for the session lifetime.
      closePending: false,
      closeSent: false,
      closeRetryCount: 0,
      closeRetryCooldownUntil: undefined,
    })
    polling.start()
    return { ok: true, paneId: result.paneId }
  }

  function queueDeferred(entry, reason) {
    if (deferredSessions.length >= MAX_DEFERRED_QUEUE_SIZE) {
      log(`deferred queue is full (${MAX_DEFERRED_QUEUE_SIZE}); dropping session ${entry.sessionID}`)
      return
    }
    deferredSessions.push({ ...entry, queuedAt: Date.now(), reason })
  }

  async function drainSpawnQueue() {
    if (drainRunning) return
    drainRunning = true
    try {
      while (spawnQueue.length > 0) {
        const entry = spawnQueue.shift()
        if (!entry) continue
        const result = await spawnPendingSession(entry)
        if (!result.ok) {
          if (result.paneId) await closeTmuxPane({ runner, paneId: result.paneId, sleep })
          if (result.deferred) queueDeferred(entry, result.error)
          else log(`spawn failed for ${entry.sessionID}: ${result.error}`)
        }
      }
    } finally {
      drainRunning = false
    }
  }

  function startDeferredLoop() {
    if (deferredLoop || deferredLoopStopped) return
    deferredLoop = setInterval(() => {
      const now = Date.now()
      while (deferredSessions.length > 0 && now - deferredSessions[0].queuedAt > DEFERRED_SESSION_TTL_MS) {
        deferredSessions.shift()
      }
      const entry = deferredSessions.shift()
      if (entry) spawnQueue.push(entry)
      void drainSpawnQueue()
    }, POLL_INTERVAL_BACKGROUND_MS)
    if (typeof deferredLoop.unref === "function") deferredLoop.unref()
  }

  // Pending-close retry/cooldown, ported from V1 `retryPendingCloses`
  // (`features/tmux-subagent/manager.ts:511-582`). A failed close keeps the
  // session tracked with `closePending=true`; each polling pass retries once,
  // incrementing `closeRetryCount`; after MAX_CLOSE_RETRY_COUNT failures the
  // session is stamped with `closeRetryCooldownUntil` instead of leaking the
  // pane. Once the cooldown elapses, the retry state resets so polling can
  // re-attempt. No timer is used: the cooldown is a timestamp compared on the
  // next pass, so a wedged pane cannot hang the process.
  async function retryPendingCloses(now = Date.now()) {
    for (const tracked of [...sessions.values()]) {
      if (!tracked.closePending || !sessions.has(tracked.sessionID)) continue
      const retryCount = tracked.closeRetryCount ?? 0
      if (retryCount >= MAX_CLOSE_RETRY_COUNT) {
        if (tracked.closeRetryCooldownUntil != null && now >= tracked.closeRetryCooldownUntil) {
          tracked.closeRetryCount = 0
          tracked.closePending = false
          tracked.closeSent = false
          tracked.closeRetryCooldownUntil = undefined
          log(`close-retry cooldown elapsed for ${tracked.sessionID}; retry state reset for a fresh attempt`)
        }
        continue
      }
      const result = await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
      if (result.closed) {
        sessions.delete(tracked.sessionID)
        log(`retried close succeeded for ${tracked.sessionID}`)
        continue
      }
      const nextRetryCount = retryCount + 1
      tracked.closeRetryCount = nextRetryCount
      if (nextRetryCount >= MAX_CLOSE_RETRY_COUNT) {
        tracked.closeRetryCooldownUntil = now + CLOSE_RETRY_COOLDOWN_MS
        log(`close retries exhausted for ${tracked.sessionID}; cooldown ${CLOSE_RETRY_COOLDOWN_MS / 60000}min armed`)
      } else {
        log(`retried close failed for ${tracked.sessionID}: ${result.reason} (retry ${nextRetryCount}/${MAX_CLOSE_RETRY_COUNT})`)
      }
    }
  }

  const polling = createTmuxVizPolling({
    getTrackedSessions: () => sessions,
    closeSessionById: async (sessionID) => {
      // The polling pass already set `closeSent` before this call: this is the
      // first close attempt for a session polling decided to close. A failure
      // leaves the session tracked as pending; `retryPendingCloses` (the
      // `onPoll` callback) handles every subsequent attempt with retry/cooldown.
      const tracked = sessions.get(sessionID)
      if (!tracked) return
      const result = await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
      if (result.closed) {
        sessions.delete(sessionID)
        return
      }
      tracked.closePending = true
      log(`close failed for ${sessionID}: ${result.reason}; pending retry`)
    },
    onPoll: (now) => retryPendingCloses(now),
    runner: enabled ? runner : createTmuxVizRunner({ tmuxPath: "/nonexistent-tmux-viz", spawnImpl: () => ({ exitCode: Promise.resolve(1), stdout: Promise.resolve(""), stderr: Promise.resolve("") }) }),
    serverUrl,
    directory,
    fetchSessionStatus,
    cmux: environment.cmux,
    logger,
  })

  return {
    enabled,
    degradedReason: environment.degradedReason,
    environment,
    retryPendingCloses,
    getTrackedPaneId(sessionID) { return sessions.get(sessionID)?.paneId ?? null },
    async onSessionCreated(event) {
      if (!enabled) return
      if (event?.type !== "session.created") return
      const info = event?.properties?.info
      const sessionID = info?.id
      if (typeof sessionID !== "string" || !info?.parentID || pendingSessions.has(sessionID) || sessions.has(sessionID)) return
      if (!environment.sourcePaneId && resolved.isolation === "inline") return
      if (shouldSkipSession(sessionID)) return
      if (!sweptOnce) {
        sweptOnce = true
        try {
          const killed = await sweepStaleTmuxResources({ runner, managerPid, isServerAlive: (url) => url === serverUrl })
          if (killed.sessions.length > 0 || killed.panes.length > 0) log(`zombie sweep: ${JSON.stringify(killed)}`)
        } catch (error) {
          log(`zombie sweep failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      pendingSessions.add(sessionID)
      spawnQueue.push({ sessionID, description: String(info.title ?? sessionID).slice(0, 20) })
      startDeferredLoop()
      await drainSpawnQueue().catch((error) => log(`spawn queue drain failed: ${error instanceof Error ? error.message : String(error)}`))
      pendingSessions.delete(sessionID)
    },
    async onSessionDeleted({ sessionID } = {}) {
      if (!enabled || typeof sessionID !== "string") return
      const tracked = sessions.get(sessionID)
      if (!tracked) return
      const result = await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
      if (!result.closed) {
        // Keep the session tracked; `closeSent` blocks the polling one-shot so
        // the pending-close retry (with cooldown) owns every later attempt.
        tracked.closePending = true
        tracked.closeSent = true
        log(`close failed for ${sessionID}: ${result.reason}; pending retry`)
        return
      }
      sessions.delete(sessionID)
      if (tracked.isolated && resolved.isolation === "session") {
        await runner.run(["kill-session", "-t", `omo-agents-${managerPid}`])
      }
    },
    onEvent(event) { polling.handleEvent(event) },
    async cleanup() {
      if (!enabled) return
      deferredLoopStopped = true
      if (deferredLoop) clearInterval(deferredLoop)
      polling.stop()
      for (const tracked of [...sessions.values()]) {
        await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
        sessions.delete(tracked.sessionID)
      }
      if (resolved.isolation === "session" && sessions.size === 0) {
        await runner.run(["kill-session", "-t", `omo-agents-${managerPid}`])
      }
    },
  }
}
