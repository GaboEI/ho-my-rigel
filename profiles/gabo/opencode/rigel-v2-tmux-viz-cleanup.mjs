/**
 * Native V2 tmux visualization: cleanup (rewrite of V1 `tmux-core/pane-close`,
 * the manager pending-close retry loop and `stale-tmux-resource-sweeper.ts`).
 *
 * Contract:
 * - Closing a pane sends `C-c`, waits briefly, then kills it; a tmux
 *   "can't find pane" error is already-success, not a failure.
 * - Pending closes retry up to 3 times; after that a 15 minute cooldown is
 *   armed once before the retry state resets.
 * - The zombie sweep runs once per process on the first session.created: it
 *   kills `omo-agents-<pid>` sessions whose owning PID is dead and orphan
 *   `omo-subagent-*`/`omo-team-*` panes whose recorded attach server is down.
 */

export const MAX_CLOSE_RETRY_COUNT = 3
export const CLOSE_RETRY_COOLDOWN_MS = 15 * 60 * 1000
export const CLOSE_INTERMEDIATE_DELAY_MS = 250

export function isPaneGoneError(stderr) {
  return /can't find pane/i.test(String(stderr ?? ""))
}

export async function closeTmuxPane({ runner, paneId, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const interrupt = await runner.run(["send-keys", "-t", paneId, "C-c"])
  if (interrupt.exitCode !== 0 && !isPaneGoneError(interrupt.stderr)) {
    return { closed: false, reason: `send-keys failed: ${interrupt.stderr.trim().slice(0, 200)}` }
  }
  await sleep(CLOSE_INTERMEDIATE_DELAY_MS)
  const kill = await runner.run(["kill-pane", "-t", paneId])
  if (kill.exitCode !== 0 && !isPaneGoneError(kill.stderr)) {
    return { closed: false, reason: `kill-pane failed: ${kill.stderr.trim().slice(0, 200)}` }
  }
  return { closed: true, reason: null }
}

export function buildStaleSessionSweepArgs() {
  return ["list-sessions", "-F", "#{session_name}"]
}

export function buildStalePaneSweepArgs() {
  return ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_title}\t#{@omo_attach_server_url}\t#{pane_current_command}"]
}

export function parseStaleSessions(stdout, livePids, managerPid) {
  const stale = []
  for (const line of String(stdout ?? "").split("\n")) {
    const name = line.trim()
    if (!name.startsWith("omo-agents-")) continue
    const pidPart = name.slice("omo-agents-".length).split("-")[0]
    const pid = Number.parseInt(pidPart, 10)
    if (Number.isInteger(pid) && pid !== managerPid && !livePids.has(pid)) stale.push(name)
  }
  return stale
}

export function parseStalePanes(stdout, isServerAlive) {
  const stale = []
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue
    const [paneId, title, attachServerUrl, command] = line.split("\t")
    if (!paneId) continue
    const isOmoPane = typeof title === "string" && (title.startsWith("omo-subagent-") || title.startsWith("omo-team-"))
    if (!isOmoPane) continue
    const recordedServer = typeof attachServerUrl === "string" && attachServerUrl ? attachServerUrl : null
    const stillRunningCommand = typeof command === "string" && command.includes("opencode")
    if (recordedServer && !isServerAlive(recordedServer) && !stillRunningCommand) stale.push(paneId)
  }
  return stale
}

/**
 * Run the one-shot zombie sweep: kill orphaned `omo-agents-<dead pid>`
 * sessions and orphan omo panes whose recorded attach server is down.
 * Returns a summary object suitable for an observability log line.
 */
export async function sweepStaleTmuxResources({ runner, managerPid, isServerAlive }) {
  const killed = { sessions: [], panes: [] }
  const livePids = new Set([managerPid])
  const sessions = await runner.run(buildStaleSessionSweepArgs())
  if (sessions.exitCode === 0) {
    for (const name of parseStaleSessions(sessions.stdout, livePids, managerPid)) {
      const result = await runner.run(["kill-session", "-t", name])
      if (result.exitCode === 0) killed.sessions.push(name)
    }
  }
  const panes = await runner.run(buildStalePaneSweepArgs())
  if (panes.exitCode === 0) {
    for (const paneId of parseStalePanes(panes.stdout, isServerAlive)) {
      const result = await closeTmuxPane({ runner, paneId })
      if (result.closed) killed.panes.push(paneId)
    }
  }
  return killed
}
