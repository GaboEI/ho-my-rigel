import { describe, expect, test } from "bun:test"
import { createTmuxVizPolling, STABLE_POLLS_REQUIRED, MIN_STABILITY_TIME_MS } from "./rigel-v2-tmux-viz-polling.mjs"

function harness({ tracked, status = null } = {}) {
  const sessions = new Map(tracked ?? [])
  const closes = []
  let statuses = status
  const polling = createTmuxVizPolling({
    getTrackedSessions: () => sessions,
    closeSessionById: async (sessionID) => { closes.push(sessionID); sessions.delete(sessionID) },
    runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    serverUrl: "http://127.0.0.1:1",
    directory: "/work",
    fetchSessionStatus: async () => statuses,
    logger: () => {},
  })
  return {
    sessions, closes, polling,
    setStatus: (map) => { statuses = map },
  }
}

function trackedSession(overrides = {}) {
  return {
    sessionID: "ses_child",
    paneId: "%1",
    isolated: false,
    cmux: false,
    createdAt: Date.now(),
    activityVersion: 0,
    stablePolls: 0,
    attachActivated: true,
    lastSeenAt: Date.now(),
    ...overrides,
  }
}

describe("tmux-viz polling", () => {
  test("an idle session with unchanged activity over the stability window is closed", async () => {
    const created = Date.now() - MIN_STABILITY_TIME_MS - 1000
    const harness1 = harness({ tracked: [["ses_child", trackedSession({ createdAt: created, lastSeenAt: created })]] })
    harness1.setStatus(new Map([["ses_child", "idle"]]))
    // given: STABLE_POLLS_REQUIRED unchanged ticks...
    for (let index = 0; index < STABLE_POLLS_REQUIRED; index += 1) await harness1.polling.pollOnce(Date.now() + 1000 * (index + 1))
    // when: the confirming recheck still reports idle
    await harness1.polling.pollOnce(Date.now() + 10_000)
    // then
    expect(harness1.closes).toEqual(["ses_child"])
  })

  test("a session whose activity keeps changing is never stability-closed", async () => {
    const created = Date.now() - MIN_STABILITY_TIME_MS - 1000
    const harness1 = harness({ tracked: [["ses_child", trackedSession({ createdAt: created, lastSeenAt: created })]] })
    harness1.setStatus(new Map([["ses_child", "running"]]))
    for (let index = 0; index < STABLE_POLLS_REQUIRED + 2; index += 1) {
      harness1.sessions.get("ses_child").activityVersion += 1
      await harness1.polling.pollOnce(Date.now() + 1000 * (index + 1))
    }
    expect(harness1.closes).toEqual([])
  })

  test("V2 activity (output, tool progress, mutation) bumps the tracked session", () => {
    const harness1 = harness({ tracked: [["ses_child", trackedSession()]] })
    // given: assistant output in the raw (`data.sessionID`) and enriched shapes
    harness1.polling.handleEvent({ type: "session.text.delta", data: { sessionID: "ses_child" } })
    harness1.polling.handleEvent({ type: "session.step.started", sessionID: "ses_child" })
    // a long tool that streams progress must reset the stability window
    harness1.polling.handleEvent({ type: "session.tool.progress", data: { sessionID: "ses_child" } })
    // a message removal / revert is activity for the pane
    harness1.polling.handleEvent({ type: "session.revert.staged", data: { sessionID: "ses_child" } })
    harness1.polling.handleEvent({ type: "session.revert.cleared", sessionID: "ses_child" })
    expect(harness1.sessions.get("ses_child").activityVersion).toBe(5)
    // when: a non-activity edge, and the V1 names V2 never emits, arrive
    harness1.polling.handleEvent({ type: "session.idle", sessionID: "ses_child" })
    harness1.polling.handleEvent({ type: "message.updated", data: { sessionID: "ses_child" } })
    harness1.polling.handleEvent({ type: "message.removed", data: { sessionID: "ses_child" } })
    // then: none of them bump the activity version
    expect(harness1.sessions.get("ses_child").activityVersion).toBe(5)
  })

  test("a focused placeholder pane is respawned as attach within the auto-activate grace", async () => {
    const sessions = new Map([["ses_child", trackedSession({ attachActivated: false })]])
    const replacements = []
    const polling = createTmuxVizPolling({
      getTrackedSessions: () => sessions,
      closeSessionById: async () => {},
      runner: { run: async (args) => { replacements.push(args); return { exitCode: 0, stdout: "", stderr: "" } } },
      serverUrl: "http://127.0.0.1:1",
      directory: "/work",
      fetchSessionStatus: async () => new Map(),
      logger: () => {},
    })
    sessions.get("ses_child").lastWindowState = { agentPanes: [{ paneId: "%1", active: true }], windowActive: true, sessionAttached: true }
    await polling.pollOnce(Date.now())
    expect(replacements[0]).toContain("respawn-pane")
    expect(sessions.get("ses_child").attachActivated).toBe(true)
  })
})
