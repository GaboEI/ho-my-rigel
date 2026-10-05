import { describe, expect, test } from "bun:test"
import {
  buildContinuationPrompt,
  createGoalContinuation,
  createGoalController,
  createGoalTools,
  createV2GoalStore,
  formatGoalResponse,
  GOAL_TOOL_NAMES,
  InvalidObjectiveError,
  MAX_OBJECTIVE_LENGTH,
  sessionIDFromEvent,
  parseGoalCommand,
  validateObjective,
} from "./goal.tools.mjs"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
  }
}

function fixedGoalStore(storage, start = 1000) {
  let tick = start
  let seq = 0
  return createV2GoalStore({
    storage,
    clock: () => { tick += 1; return tick },
    idFactory: () => `g-${seq++}`,
  })
}

describe("goal objective validation", () => {
  test("trims, rejects empty, and enforces the 2000 character ceiling", () => {
    expect(validateObjective("  Ship  ")).toBe("Ship")
    expect(() => validateObjective("   ")).toThrow(InvalidObjectiveError)
    expect(() => validateObjective("x".repeat(MAX_OBJECTIVE_LENGTH + 1))).toThrow(/exceeds maximum length/)
    expect(validateObjective("x".repeat(MAX_OBJECTIVE_LENGTH))).toHaveLength(MAX_OBJECTIVE_LENGTH)
  })
})

describe("goal slash command parsing", () => {
  test("maps V1-compatible verbs and objectives", () => {
    // given / when / then
    expect(parseGoalCommand("")).toEqual({ kind: "show" })
    expect(parseGoalCommand("show")).toEqual({ kind: "show" })
    expect(parseGoalCommand("pause")).toEqual({ kind: "setStatus", status: "paused" })
    expect(parseGoalCommand("resume")).toEqual({ kind: "setStatus", status: "active" })
    expect(parseGoalCommand("clear")).toEqual({ kind: "clear" })
    expect(parseGoalCommand("  Ship Wave 1  ")).toEqual({ kind: "setObjective", objective: "Ship Wave 1" })
  })
})

describe("goal store and controller over V2 storage", () => {
  test("creates a v1 goal envelope and survives a round trip", async () => {
    const storage = memoryStorage()
    const store = fixedGoalStore(storage)
    const goal = await store.createGoal("ses_1", "Ship")
    expect(goal.status).toBe("active")
    expect(goal.lastStartedAt).toBeGreaterThan(0)
    expect(storage.map.get("rigel-v2/goal/ses_1")).toMatchObject({ version: 1 })
    expect(await store.readGoal("ses_1")).toEqual(goal)
  })

  test("returns null for absent, malformed, wrong-version, and null goals", async () => {
    const storage = memoryStorage()
    const store = fixedGoalStore(storage)
    expect(await store.readGoal("ses_none")).toBeNull()
    await storage.set("rigel-v2/goal/ses_bad", "not json")
    expect(await store.readGoal("ses_bad")).toBeNull()
    await storage.set("rigel-v2/goal/ses_v2", { version: 2, goal: null })
    expect(await store.readGoal("ses_v2")).toBeNull()
    await storage.set("rigel-v2/goal/ses_null", { version: 1, goal: null })
    expect(await store.readGoal("ses_null")).toBeNull()
  })

  test("setGoal replaces the prior goal and resets usage", async () => {
    const storage = memoryStorage()
    const controller = createGoalController({ store: fixedGoalStore(storage) })
    const first = await controller.setGoal("ses_1", "First")
    await controller.accountUsage("ses_1", { input: 10, output: 5 }, 7)
    expect((await controller.getGoal("ses_1")).tokensUsed).toBe(15)
    const second = await controller.setGoal("ses_1", "Second")
    expect(second.id).not.toBe(first.id)
    expect(second.tokensUsed).toBe(0)
    expect((await controller.getGoal("ses_1")).objective).toBe("Second")
  })

  test("pause/resume/complete set the expected lifecycle fields", async () => {
    const storage = memoryStorage()
    const controller = createGoalController({ store: fixedGoalStore(storage) })
    await controller.setGoal("ses_1", "Ship")
    expect((await controller.pauseGoal("ses_1")).status).toBe("paused")
    const resumed = await controller.resumeGoal("ses_1")
    expect(resumed.status).toBe("active")
    expect(resumed.lastStartedAt).toBeGreaterThan(0)
    const completed = await controller.markComplete("ses_1")
    expect(completed.status).toBe("complete")
    expect(completed.completedAt).toBeGreaterThan(0)
  })

  test("accountUsage only accrues while active", async () => {
    const storage = memoryStorage()
    const controller = createGoalController({ store: fixedGoalStore(storage) })
    await controller.setGoal("ses_1", "Ship")
    await controller.pauseGoal("ses_1")
    const paused = await controller.accountUsage("ses_1", { input: 100, output: 100 }, 10)
    expect(paused.tokensUsed).toBe(0)
    await controller.resumeGoal("ses_1")
    const active = await controller.accountUsage("ses_1", { input: 100, output: 50 }, 10)
    expect(active.tokensUsed).toBe(150)
    expect(active.timeUsedSeconds).toBe(10)
  })

  test("clearGoal reports whether a goal existed and removes it", async () => {
    const storage = memoryStorage()
    const controller = createGoalController({ store: fixedGoalStore(storage) })
    await controller.setGoal("ses_1", "Ship")
    expect(await controller.clearGoal("ses_1")).toBe(true)
    expect(await controller.clearGoal("ses_1")).toBe(false)
    expect(await controller.getGoal("ses_1")).toBeNull()
  })
})

describe("goal tool contracts", () => {
  function toolsWithSession(sessionID, storage = memoryStorage()) {
    const controller = createGoalController({ store: fixedGoalStore(storage) })
    return { controller, tools: createGoalTools({ controller, getSessionID: () => sessionID }) }
  }

  test("create_goal writes to the current session and returns the snapshot shape", async () => {
    const { controller, tools } = toolsWithSession("ses_1")
    const result = JSON.parse(await tools.create_goal.execute({ objective: "Ship" }, {}))
    expect(result.goal).toMatchObject({ sessionID: "ses_1", objective: "Ship", status: "active", tokensUsed: 0, timeUsedSeconds: 0 })
    expect(result.goal.id).toBeUndefined()
    expect(await controller.getGoal("ses_1")).not.toBeNull()
  })

  test("create_goal honors an explicit session_id and errors without one", async () => {
    const { controller, tools } = toolsWithSession(undefined)
    await tools.create_goal.execute({ objective: "Ship", session_id: "ses_2" }, {})
    expect((await controller.getGoal("ses_2")).objective).toBe("Ship")
    expect(await tools.create_goal.execute({ objective: "Ship" }, {})).toContain("no session_id")
  })

  test("update_goal completes, pauses, and replaces the objective", async () => {
    const { controller, tools } = toolsWithSession("ses_1")
    await tools.create_goal.execute({ objective: "Ship" }, {})
    expect(JSON.parse(await tools.update_goal.execute({ status: "complete" }, {})).goal.status).toBe("complete")
    await tools.create_goal.execute({ objective: "Ship again" }, {})
    expect(JSON.parse(await tools.update_goal.execute({ status: "paused" }, {})).goal.status).toBe("paused")
    const renamed = JSON.parse(await tools.update_goal.execute({ objective: "New" }, {}))
    expect(renamed.goal.objective).toBe("New")
    expect((await controller.getGoal("ses_1")).objective).toBe("New")
  })

  test("get_goal returns null when no goal exists", async () => {
    const { tools } = toolsWithSession("ses_1")
    expect(JSON.parse(await tools.get_goal.execute({}, {}))).toEqual({ goal: null })
  })

  test("exposes exactly the three goal tool names", () => {
    const { tools } = toolsWithSession("ses_1")
    expect(Object.keys(tools)).toEqual(GOAL_TOOL_NAMES)
  })
})

describe("goal continuation prompt and dispatch", () => {
  test("wraps the objective as untrusted and escapes XML", () => {
    const prompt = buildContinuationPrompt({ objective: "<b>&x</b>", tokensUsed: 3, timeUsedSeconds: 4 })
    expect(prompt).toContain("<untrusted_objective>\n&lt;b&gt;&amp;x&lt;/b&gt;\n</untrusted_objective>")
    expect(prompt).toContain("- Tokens used: 3")
    expect(prompt).toContain("- Time spent pursuing goal: 4 seconds")
  })

  test("dispatches once per idle edge and guards against re-entry", async () => {
    const storage = memoryStorage()
    const controller = createGoalController({ store: fixedGoalStore(storage) })
    await controller.setGoal("ses_1", "Ship")
    const dispatched = []
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const continuation = createGoalContinuation({
      controller,
      dispatch: async (input) => { dispatched.push(input); await gate },
    })
    const first = continuation.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })
    await continuation.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })
    expect(dispatched).toHaveLength(1)
    release()
    await first
    expect(dispatched[0].sessionID).toBe("ses_1")
    expect(dispatched[0].text).toContain("Continue working toward the active thread goal.")
  })

  test("does not dispatch for a paused goal and clears on session.deleted", async () => {
    const storage = memoryStorage()
    const controller = createGoalController({ store: fixedGoalStore(storage) })
    await controller.setGoal("ses_1", "Ship")
    await controller.pauseGoal("ses_1")
    const dispatched = []
    const continuation = createGoalContinuation({ controller, dispatch: async (input) => dispatched.push(input) })
    await continuation.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })
    expect(dispatched).toHaveLength(0)
    await continuation.handleEvent({ type: "session.deleted", properties: { sessionID: "ses_1" } })
    expect(await controller.getGoal("ses_1")).toBeNull()
  })

  test("reads the session id from V2 event shapes", () => {
    expect(sessionIDFromEvent({ type: "session.idle", properties: { sessionID: "a" } })).toBe("a")
    expect(sessionIDFromEvent({ type: "session.deleted", data: { sessionID: "b" } })).toBe("b")
    expect(sessionIDFromEvent({ type: "session.deleted", data: { session: { id: "c" } } })).toBe("c")
    expect(sessionIDFromEvent({})).toBeUndefined()
  })

  test("formatGoalResponse omits internal fields", () => {
    const response = JSON.parse(formatGoalResponse({
      id: "g", sessionID: "s", objective: "o", status: "active",
      tokensUsed: 1, timeUsedSeconds: 2, createdAt: 3, updatedAt: 4, lastStartedAt: 3,
    }))
    expect(response.goal).toEqual({ sessionID: "s", objective: "o", status: "active", tokensUsed: 1, timeUsedSeconds: 2, createdAt: 3, updatedAt: 4 })
  })
})
