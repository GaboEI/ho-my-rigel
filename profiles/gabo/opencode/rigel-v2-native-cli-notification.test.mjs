import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNotificationPlugin } from "./rigel-v2-native-cli-notification.mjs"
import { writeTodoPending } from "./rigel-v2-native-todo-pending.mjs"

function createClock() {
  let current = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => current,
    setTimer: (callback, delay) => {
      const id = nextId++
      timers.set(id, { callback, at: current + delay })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    async advance(ms) {
      current += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= current) {
          timers.delete(id)
          timer.callback()
        }
      }
      await flush()
    },
  }
}

async function flush(count = 12) {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

function createFakeApi({ options, directory, sessions = {}, messages = {}, renderer = { isDestroyed: false } } = {}) {
  const handlers = new Map()
  const attentionCalls = []
  const toastCalls = []
  const unsubscribed = []
  let allEvents = null
  let allEventsOff = null
  const api = {
    options,
    renderer,
    location: { current: { directory } },
    data: {
      on(name, handler) {
        handlers.set(name, handler)
        return () => {
          handlers.delete(name)
          unsubscribed.push(name)
        }
      },
      subscribe(handler) {
        allEvents = handler
        allEventsOff = () => unsubscribed.push("all")
        return allEventsOff
      },
      session: {
        get: (sessionID) => sessions[sessionID],
        root: (sessionID) => sessions[sessionID]?.root ?? sessionID,
        message: { list: (sessionID) => messages[sessionID] ?? [] },
      },
    },
    attention: {
      notify: async (payload) => {
        attentionCalls.push(payload)
        return { ok: true, notification: false, sound: false, skipped: null }
      },
    },
    ui: { toast: { show: (payload) => toastCalls.push(payload) } },
  }
  return {
    api,
    handlers,
    attentionCalls,
    toastCalls,
    unsubscribed,
    emitAll: (event) => allEvents?.({ name: event?.type, details: event }),
    handler: (name) => handlers.get(name),
  }
}

describe("createNotificationPlugin", () => {
  let logDir
  let logFile
  let stateDir
  const originalXdgState = process.env.XDG_STATE_HOME

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "rigel-notif-"))
    logFile = join(logDir, "session-notification.log")
    // Isolate the shared emission guard / todo bridge per test so request ids
    // never leak across cases through the real state root.
    stateDir = mkdtempSync(join(tmpdir(), "rigel-notif-state-"))
    process.env.XDG_STATE_HOME = stateDir
  })

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    if (originalXdgState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalXdgState
  })

  describe("#given no notification config", () => {
    test("#then setup registers nothing and writes nothing", () => {
      const fake = createFakeApi({ options: {}, directory: logDir })
      const plugin = createNotificationPlugin({ logFile })
      const cleanup = plugin.setup(fake.api)

      expect(cleanup).toBeUndefined()
      expect(fake.handlers.size).toBe(0)
      expect(existsSync(logFile)).toBe(false)
    })

    test("#then a disabled config is also inert", () => {
      const fake = createFakeApi({ options: { notification: { enabled: false } }, directory: logDir })
      const cleanup = createNotificationPlugin({ logFile }).setup(fake.api)

      expect(cleanup).toBeUndefined()
      expect(fake.handlers.size).toBe(0)
      expect(existsSync(logFile)).toBe(false)
    })
  })

  describe("#given a headless renderer", () => {
    test("#then setup skips without registering and logs the skip", () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        renderer: null,
      })
      const cleanup = createNotificationPlugin({ logFile }).setup(fake.api)

      expect(cleanup).toBeUndefined()
      expect(fake.handlers.size).toBe(0)
      expect(readFileSync(logFile, "utf-8")).toContain("headless-skip")
    })
  })

  describe("#given an input-needed permission", () => {
    test("#then attention and toast fire with the permission message", async () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true, playSound: true } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", title: "My session", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile }).setup(fake.api)

      fake.handler("permission.asked")({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } })
      await flush()

      expect(fake.attentionCalls).toHaveLength(1)
      expect(fake.attentionCalls[0].message).toBe("Agent needs permission to continue")
      expect(fake.attentionCalls[0].notification).toEqual({ when: "blurred" })
      expect(fake.attentionCalls[0].sound).toEqual({ name: "permission", when: "always" })
      expect(fake.toastCalls).toHaveLength(1)
      expect(fake.toastCalls[0].sessionID).toBe("ses_1")
    })

    test("#then the same request id is not announced twice", async () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile }).setup(fake.api)
      const handler = fake.handler("permission.asked")

      handler({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } })
      handler({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } })
      await flush()

      expect(fake.attentionCalls).toHaveLength(1)
    })

    test("#then no sound is requested when playSound is off", async () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile }).setup(fake.api)
      fake.handler("permission.asked")({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_1" } })
      await flush()

      expect("sound" in fake.attentionCalls[0]).toBe(false)
    })
  })

  describe("#given a subagent session", () => {
    test("#then the notification is suppressed", async () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        sessions: { ses_child: { id: "ses_child", parentID: "ses_root", root: "ses_root" } },
      })
      createNotificationPlugin({ logFile }).setup(fake.api)
      fake.handler("permission.asked")({ type: "permission.asked", data: { id: "perm_1", sessionID: "ses_child" } })
      await flush()

      expect(fake.attentionCalls).toHaveLength(0)
      expect(fake.toastCalls).toHaveLength(0)
      expect(readFileSync(logFile, "utf-8")).toContain("subagent")
    })
  })

  describe("#given an input-needed form", () => {
    test("#then a question message is used and permission hints switch the message", async () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile }).setup(fake.api)
      const handler = fake.handler("form.created")

      handler({ type: "form.created", data: { form: { id: "form_1", sessionID: "ses_1", title: "Pick a color" } } })
      handler({ type: "form.created", data: { form: { id: "form_2", sessionID: "ses_1", title: "Do you allow this?" } } })
      await flush()

      expect(fake.attentionCalls).toHaveLength(2)
      expect(fake.attentionCalls[0].message).toBe("Agent is asking a question")
      expect(fake.attentionCalls[0].title).toBe("Pick a color")
      expect(fake.attentionCalls[1].message).toBe("Agent needs permission to continue")
    })
  })

  describe("#given a contained effect failure", () => {
    test("#then the handler does not throw and the failure is logged", async () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      fake.api.attention.notify = async () => {
        throw new Error("renderer blew up")
      }
      createNotificationPlugin({ logFile }).setup(fake.api)

      expect(() => fake.handler("permission.asked")({ type: "permission.asked", data: { id: "p", sessionID: "ses_1" } })).not.toThrow()
      await flush()
      expect(readFileSync(logFile, "utf-8")).toContain("emit-failed")
    })
  })

  describe("#given an idle event", () => {
    test("#then the notice fires after the confirmation delay with session content", async () => {
      const clock = createClock()
      const fake = createFakeApi({
        options: { notification: { enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 0, skipIfIncompleteTodos: false } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", title: "Fix bug", root: "ses_1" } },
        messages: { ses_1: [{ type: "user", text: "fix it" }, { type: "assistant", content: [{ type: "text", text: "done" }] }] },
      })
      createNotificationPlugin({ logFile, timer: clock }).setup(fake.api)

      fake.handler("session.idle")({ type: "session.idle", data: { sessionID: "ses_1" } })
      await clock.advance(50)
      expect(fake.attentionCalls).toHaveLength(0)
      await clock.advance(60)

      expect(fake.attentionCalls).toHaveLength(1)
      expect(fake.attentionCalls[0].title).toBe("OpenCode · Fix bug")
      expect(fake.attentionCalls[0].message).toContain("Assistant: done")
    })

    test("#then activity cancels the pending notice", async () => {
      const clock = createClock()
      const fake = createFakeApi({
        options: { notification: { enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 0, skipIfIncompleteTodos: false } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile, timer: clock }).setup(fake.api)

      fake.handler("session.idle")({ type: "session.idle", data: { sessionID: "ses_1" } })
      fake.emitAll({ type: "session.text.delta", data: { sessionID: "ses_1" } })
      await clock.advance(200)

      expect(fake.attentionCalls).toHaveLength(0)
    })

    test("#then the V2 execution lifecycle also raises the completion notice", async () => {
      const clock = createClock()
      const fake = createFakeApi({
        options: { notification: { enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 0, skipIfIncompleteTodos: false } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", title: "Done run", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile, timer: clock }).setup(fake.api)

      fake.handler("session.execution.succeeded")({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
      await clock.advance(120)

      expect(fake.attentionCalls).toHaveLength(1)
      expect(fake.toastCalls).toHaveLength(1)
    })
  })

  describe("#given two plugin instances sharing a state root", () => {
    test("#then the same input-needed request id is announced once", async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), "rigel-notif-shared-"))
      const logA = join(logDir, "a.log")
      const logB = join(logDir, "b.log")
      const build = () => createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      const first = build()
      const second = build()
      createNotificationPlugin({ logFile: logA, stateRoot }).setup(first.api)
      createNotificationPlugin({ logFile: logB, stateRoot }).setup(second.api)

      const event = { type: "permission.asked", data: { id: "per_shared", sessionID: "ses_1" } }
      first.handler("permission.asked")(event)
      second.handler("permission.asked")(event)
      await flush()

      expect(first.attentionCalls.length + second.attentionCalls.length).toBe(1)
      const totalDedup = `${readFileSync(logA, "utf-8")}${readFileSync(logB, "utf-8")}`
      expect(totalDedup).toContain("deduplicated")
      rmSync(stateRoot, { recursive: true, force: true })
    })
  })

  describe("#given an incomplete-todo session", () => {
    test("#then the completion notice is suppressed and later allowed once the todo completes", async () => {
      const clock = createClock()
      const stateRoot = mkdtempSync(join(tmpdir(), "rigel-notif-todos-"))
      const fake = createFakeApi({
        options: { notification: { enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 0 } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile, timer: clock, stateRoot }).setup(fake.api)

      writeTodoPending({ stateRoot, sessionID: "ses_1", todos: [{ status: "pending" }] })
      fake.handler("session.execution.succeeded")({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
      await clock.advance(120)
      expect(fake.attentionCalls).toHaveLength(0)
      expect(readFileSync(logFile, "utf-8")).toContain("incomplete-todos")

      writeTodoPending({ stateRoot, sessionID: "ses_1", todos: [{ status: "completed" }] })
      fake.emitAll({ type: "session.execution.started", data: { sessionID: "ses_1" } })
      fake.handler("session.execution.succeeded")({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
      await clock.advance(120)
      expect(fake.attentionCalls).toHaveLength(1)
      rmSync(stateRoot, { recursive: true, force: true })
    })

    test("#then pending todos in one session do not suppress another session", async () => {
      const clock = createClock()
      const stateRoot = mkdtempSync(join(tmpdir(), "rigel-notif-todos-"))
      const fake = createFakeApi({
        options: { notification: { enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 0 } },
        directory: logDir,
        sessions: { ses_a: { id: "ses_a", root: "ses_a" }, ses_b: { id: "ses_b", root: "ses_b" } },
      })
      createNotificationPlugin({ logFile, timer: clock, stateRoot }).setup(fake.api)
      writeTodoPending({ stateRoot, sessionID: "ses_a", todos: [{ status: "pending" }] })

      fake.handler("session.execution.succeeded")({ type: "session.execution.succeeded", data: { sessionID: "ses_b" } })
      await clock.advance(120)
      expect(fake.attentionCalls).toHaveLength(1)
      expect(fake.toastCalls[0].sessionID).toBe("ses_b")
      rmSync(stateRoot, { recursive: true, force: true })
    })

    test("#then the knob being off allows the notice despite pending todos", async () => {
      const clock = createClock()
      const stateRoot = mkdtempSync(join(tmpdir(), "rigel-notif-todos-"))
      const fake = createFakeApi({
        options: { notification: { enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 0, skipIfIncompleteTodos: false } },
        directory: logDir,
        sessions: { ses_1: { id: "ses_1", root: "ses_1" } },
      })
      createNotificationPlugin({ logFile, timer: clock, stateRoot }).setup(fake.api)
      writeTodoPending({ stateRoot, sessionID: "ses_1", todos: [{ status: "pending" }] })

      fake.handler("session.execution.succeeded")({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
      await clock.advance(120)
      expect(fake.attentionCalls).toHaveLength(1)
      rmSync(stateRoot, { recursive: true, force: true })
    })
  })

  describe("#given the plugin is disposed", () => {
    test("#then every subscription is released", () => {
      const fake = createFakeApi({
        options: { notification: { enabled: true } },
        directory: logDir,
        sessions: {},
      })
      const cleanup = createNotificationPlugin({ logFile }).setup(fake.api)
      expect(typeof cleanup).toBe("function")
      cleanup()
      expect(fake.unsubscribed).toContain("session.idle")
      expect(fake.unsubscribed).toContain("permission.asked")
      expect(fake.unsubscribed).toContain("all")
    })
  })
})
