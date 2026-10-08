import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskToastCliSurface } from "./rigel-v2-native-cli-task-toast.mjs"
import { writeBackgroundState } from "./rigel-v2-background-state.mjs"

function createFakeContext({ options, directory, renderer = { isDestroyed: false }, sessions = {} } = {}) {
  const handlers = new Map()
  const toastCalls = []
  const unsubscribed = []
  const context = {
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
      session: { get: (sessionID) => sessions[sessionID] },
    },
    ui: { toast: { show: (payload) => toastCalls.push(payload) } },
  }
  return { context, handlers, toastCalls, unsubscribed, handler: (name) => handlers.get(name) }
}

describe("createTaskToastCliSurface", () => {
  let directory
  let logs
  let now

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rigel-task-toast-"))
    logs = []
    now = 0
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function build(fake) {
    return createTaskToastCliSurface({ log: (entry) => logs.push(entry), now: () => now }).setup(fake.context)
  }

  describe("#given no task-toast config", () => {
    test("#then the surface is default-on (V1 parity) and registers handlers", () => {
      const fake = createFakeContext({ options: {}, directory })
      const cleanup = build(fake)

      expect(typeof cleanup).toBe("function")
      expect(fake.handlers.size).toBeGreaterThan(0)
    })

    test("#then an explicit enabled:false is exactly zero side effects", () => {
      const fake = createFakeContext({ options: { task_toast: { enabled: false } }, directory })
      const cleanup = build(fake)

      expect(cleanup).toBeUndefined()
      expect(fake.handlers.size).toBe(0)
      expect(logs).toHaveLength(0)
    })
  })

  describe("#given a headless renderer", () => {
    test("#then setup skips without registering and records the skip", () => {
      const fake = createFakeContext({ options: { task_toast: { enabled: true } }, directory, renderer: null })
      const cleanup = build(fake)

      expect(cleanup).toBeUndefined()
      expect(fake.handlers.size).toBe(0)
      expect(logs.some((entry) => entry.event === "headless-skip")).toBe(true)
    })
  })

  describe("#given a foreground execution", () => {
    test("#then a New Task Executed toast is emitted with the RUN icon", () => {
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: { "ses-a": { id: "ses-a", title: "alpha" } },
      })
      build(fake)

      fake.handler("session.execution.started")({ type: "session.execution.started", data: { sessionID: "ses-a" } })

      expect(fake.toastCalls).toHaveLength(1)
      expect(fake.toastCalls[0].title).toBe("New Task Executed")
      expect(fake.toastCalls[0].variant).toBe("info")
      expect(fake.toastCalls[0].duration).toBe(3000)
      expect(fake.toastCalls[0].message).toContain("[RUN] alpha")
      expect(fake.toastCalls[0].message).toContain("← NEW")
    })
  })

  describe("#given a durable background child", () => {
    test("#then a started child emits the background title and BG icon", () => {
      writeBackgroundState(directory, "parent-1", {
        tasks: [{ taskId: "t1", sessionID: "child-1", status: "running", agent: "atlas", category: "deep", model: "openai/gpt-5" }],
        wakes: [],
      })
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: { "child-1": { id: "child-1", parentID: "parent-1" } },
      })
      build(fake)

      fake.handler("session.execution.started")({ type: "session.execution.started", data: { sessionID: "child-1" } })

      expect(fake.toastCalls[0].title).toBe("New Background Task")
      expect(fake.toastCalls[0].message).toContain("[BG]")
      expect(fake.toastCalls[0].message).toContain("(gpt-5: deep)")
    })

    test("#then a queued child is announced as queued with the Q icon", () => {
      writeBackgroundState(directory, "parent-2", {
        tasks: [{ taskId: "t2", sessionID: "child-2", status: "queued", agent: "atlas" }],
        wakes: [],
      })
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: { "child-2": { id: "child-2", parentID: "parent-2" } },
      })
      build(fake)

      fake.handler("session.created")({ type: "session.created", data: { sessionID: "child-2" } })

      expect(fake.toastCalls[0].title).toBe("New Background Task")
      expect(fake.toastCalls[0].message).toContain("Queued (1):")
      expect(fake.toastCalls[0].message).toContain("[Q]")
    })
  })

  describe("#given three concurrent executions", () => {
    test("#then the third list toast uses the crowded 5000ms duration", () => {
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: {
          "ses-1": { id: "ses-1", title: "one" },
          "ses-2": { id: "ses-2", title: "two" },
          "ses-3": { id: "ses-3", title: "three" },
        },
      })
      build(fake)
      const started = fake.handler("session.execution.started")
      started({ type: "session.execution.started", data: { sessionID: "ses-1" } })
      started({ type: "session.execution.started", data: { sessionID: "ses-2" } })
      started({ type: "session.execution.started", data: { sessionID: "ses-3" } })

      expect(fake.toastCalls.map((toast) => toast.duration)).toEqual([3000, 3000, 5000])
    })
  })

  describe("#given a completed execution", () => {
    test("#then a Task Completed success toast reports the duration and remainder", () => {
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: {
          "ses-a": { id: "ses-a", title: "alpha" },
          "ses-b": { id: "ses-b", title: "beta" },
        },
      })
      build(fake)
      const started = fake.handler("session.execution.started")
      started({ type: "session.execution.started", data: { sessionID: "ses-a" } })
      started({ type: "session.execution.started", data: { sessionID: "ses-b" } })
      now = 5000

      fake.handler("session.execution.succeeded")({ type: "session.execution.succeeded", data: { sessionID: "ses-a" } })

      const completion = fake.toastCalls[fake.toastCalls.length - 1]
      expect(completion.title).toBe("Task Completed")
      expect(completion.variant).toBe("success")
      expect(completion.duration).toBe(5000)
      expect(completion.message).toContain('"alpha" finished in 5s')
      expect(completion.message).toContain("Still running: 1 | Queued: 0")
    })
  })

  describe("#given a failed execution", () => {
    test("#then the failure is contained and emits no completion toast", () => {
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: { "ses-a": { id: "ses-a", title: "alpha" } },
      })
      build(fake)
      fake.handler("session.execution.started")({ type: "session.execution.started", data: { sessionID: "ses-a" } })

      expect(() => fake.handler("session.execution.failed")({ type: "session.execution.failed", data: { sessionID: "ses-a" } })).not.toThrow()
      expect(fake.toastCalls).toHaveLength(1)
    })
  })

  describe("#given a deleted session", () => {
    test("#then the tracked task is forgotten without a new toast", () => {
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: { "ses-a": { id: "ses-a", title: "alpha" } },
      })
      build(fake)
      fake.handler("session.execution.started")({ type: "session.execution.started", data: { sessionID: "ses-a" } })

      fake.handler("session.deleted")({ type: "session.deleted", data: { sessionID: "ses-a" } })
      expect(fake.toastCalls).toHaveLength(1)
    })
  })

  describe("#given a contained toast failure", () => {
    test("#then the handler does not throw and the failure is logged", () => {
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: { "ses-a": { id: "ses-a", title: "alpha" } },
      })
      fake.context.ui.toast.show = () => {
        throw new Error("renderer blew up")
      }
      build(fake)

      expect(() => fake.handler("session.execution.started")({ type: "session.execution.started", data: { sessionID: "ses-a" } })).not.toThrow()
      expect(logs.some((entry) => entry.event === "toast-failed")).toBe(true)
    })
  })

  describe("#given the surface is disposed", () => {
    test("#then every subscription is released", () => {
      const fake = createFakeContext({
        options: { task_toast: { enabled: true } },
        directory,
        sessions: {},
      })
      const cleanup = build(fake)
      expect(typeof cleanup).toBe("function")

      cleanup()

      for (const name of ["session.created", "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.deleted"]) {
        expect(fake.unsubscribed).toContain(name)
      }
    })
  })
})
