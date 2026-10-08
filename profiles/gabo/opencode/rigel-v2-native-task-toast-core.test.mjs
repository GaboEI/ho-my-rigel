import { describe, expect, test } from "bun:test"
import {
  createTaskToastManager,
  formatDuration,
  TASK_TOAST_TITLES,
} from "./rigel-v2-native-task-toast-core.mjs"

function createHarness({ limit } = {}) {
  const toasts = []
  let now = 0
  const manager = createTaskToastManager({
    showToast: (toast) => toasts.push(toast),
    getConcurrencyLimit: limit === undefined ? undefined : () => limit,
    now: () => now,
  })
  return {
    manager,
    toasts,
    setNow: (value) => {
      now = value
    },
    advance: (ms) => {
      now += ms
    },
    last: () => toasts[toasts.length - 1],
  }
}

function runningTask(id, overrides = {}) {
  return {
    id,
    sessionID: `session-${id}`,
    description: `task ${id}`,
    agent: "atlas",
    isBackground: false,
    status: "running",
    ...overrides,
  }
}

describe("createTaskToastManager", () => {
  describe("#given a foreground and a background task", () => {
    test("#then the titles and variants match V1 exactly", () => {
      const harness = createHarness()

      harness.manager.addTask(runningTask("f1"))
      expect(harness.toasts).toHaveLength(1)
      expect(harness.toasts[0].title).toBe("New Task Executed")
      expect(harness.toasts[0].variant).toBe("info")

      harness.manager.addTask(runningTask("b1", { isBackground: true }))
      expect(harness.last().title).toBe("New Background Task")
    })

    test("#then the new task is marked with the NEW arrow and its run icon", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("f1", { description: "build the thing" }))

      expect(harness.last().message).toContain("[RUN] build the thing")
      expect(harness.last().message).toContain("← NEW")
    })
  })

  describe("#given more than two tracked tasks", () => {
    test("#then the list toast duration jumps from 3000 to 5000", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("t1"))
      harness.manager.addTask(runningTask("t2"))
      harness.manager.addTask(runningTask("t3"))

      expect(harness.toasts[0].duration).toBe(3000)
      expect(harness.toasts[1].duration).toBe(3000)
      expect(harness.toasts[2].duration).toBe(5000)
    })

    test("#then a completion toast always lasts 5000 and is a success", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("t1"))
      harness.manager.showCompletionToast({ id: "t1", description: "task t1", duration: "6s" })

      expect(harness.last().title).toBe(TASK_TOAST_TITLES.taskCompleted)
      expect(harness.last().variant).toBe("success")
      expect(harness.last().duration).toBe(5000)
    })
  })

  describe("#given tasks added at different times", () => {
    test("#then running tasks are newest-first and queued tasks oldest-first", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("old"))
      harness.advance(1000)
      harness.manager.addTask(runningTask("new"))
      harness.advance(1000)
      harness.manager.addTask({ ...runningTask("queued-late"), status: "queued" })
      harness.advance(-1500)
      harness.manager.addTask({ ...runningTask("queued-early"), status: "queued" })

      expect(harness.manager.getRunningTasks().map((task) => task.id)).toEqual(["new", "old"])
      expect(harness.manager.getQueuedTasks().map((task) => task.id)).toEqual(["queued-early", "queued-late"])
    })
  })

  describe("#given a model fallback", () => {
    test("#then the FALLBACK prefix carries the matching inherited suffix", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("f1", { modelInfo: { model: "openrouter/gpt-5", type: "inherited" } }))

      expect(harness.last().message).toContain("[FALLBACK] Model: openrouter/gpt-5 (inherited from parent)")
    })

    test("#then system-default and runtime-fallback get their own suffixes", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("s1", { modelInfo: { model: "m1", type: "system-default" } }))
      expect(harness.last().message).toContain("(system default fallback)")

      harness.manager.addTask(runningTask("r1", { modelInfo: { model: "m2", type: "runtime-fallback" } }))
      expect(harness.last().message).toContain("(runtime fallback)")
    })

    test("#then a user-defined model gets no FALLBACK prefix", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("u1", { modelInfo: { model: "anthropic/claude", type: "user-defined" } }))

      expect(harness.last().message).not.toContain("[FALLBACK]")
    })
  })

  describe("#given task identifier inputs", () => {
    test("#then model and category, model alone, agent/category, and agent are formatted like V1", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("a", { modelInfo: { model: "anthropic/claude-opus-4-7", type: "user-defined" }, category: "deep" }))
      expect(harness.last().message).toContain("(claude-opus-4-7: deep)")

      harness.manager.addTask(runningTask("b", { modelInfo: { model: "openai/gpt-5", type: "user-defined" } }))
      expect(harness.last().message).toContain("(gpt-5)")

      harness.manager.addTask(runningTask("c", { agent: "atlas", category: "deep" }))
      expect(harness.last().message).toContain("(atlas/deep)")

      harness.manager.addTask(runningTask("d", { agent: "sisyphus-junior" }))
      expect(harness.last().message).toContain("(sisyphus-junior)")
    })
  })

  describe("#given a task with skills", () => {
    test("#then the skill list is appended in brackets", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("s", { skills: ["build", "test"] }))

      expect(harness.last().message).toContain("[build, test]")
    })
  })

  describe("#given a concurrency limit", () => {
    test("#then the running header carries the total/limit suffix", () => {
      const harness = createHarness({ limit: 5 })
      harness.manager.addTask(runningTask("t1"))
      harness.manager.addTask(runningTask("t2"))

      expect(harness.last().message).toContain("Running (2): [2/5]")
    })

    test("#then an Infinity limit adds no suffix", () => {
      const harness = createHarness({ limit: Infinity })
      harness.manager.addTask(runningTask("t1"))

      expect(harness.last().message).not.toContain("[1/")
    })
  })

  describe("#given both running and queued tasks", () => {
    test("#then the queued block is separated by a blank line and uses the queued icon", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("r1"))
      harness.manager.addTask({ ...runningTask("q1"), status: "queued" })

      const message = harness.last().message
      expect(message).toContain("Running (1):")
      expect(message).toContain("\n\nQueued (1):")
      expect(message).toContain("[W] task q1")
      expect(message).toContain(" - Queued")
    })

    test("#then a background queued task uses the Q icon", () => {
      const harness = createHarness()
      harness.manager.addTask({ ...runningTask("q1"), isBackground: true, status: "queued" })

      expect(harness.last().message).toContain("[Q] task q1")
    })
  })

  describe("#given a completion with work left", () => {
    test("#then the completion message quotes the task, its duration, and the remainder", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("done", { description: "ship it" }))
      harness.manager.addTask(runningTask("stays", { isBackground: true }))
      harness.manager.addTask({ ...runningTask("waits"), status: "queued" })

      harness.manager.showCompletionToast({ id: "done", description: "ship it", duration: "1m 5s" })

      const completion = harness.last()
      expect(completion.message).toContain('"ship it" finished in 1m 5s')
      expect(completion.message).toContain("Still running: 1 | Queued: 1")
    })

    test("#then the completed task is removed from the running set", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("done"))
      harness.manager.showCompletionToast({ id: "done", description: "task done", duration: "3s" })

      expect(harness.manager.getRunningTasks()).toHaveLength(0)
    })

    test("#then a completion with no remainder omits the remainder line", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("done"))
      harness.manager.showCompletionToast({ id: "done", description: "task done", duration: "3s" })

      expect(harness.last().message).not.toContain("Still running")
    })
  })

  describe("#given updateTaskModelBySession", () => {
    test("#then a changed model re-emits the list toast with the new identifier", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("m1", { sessionID: "ses-1", category: "deep" }))
      const before = harness.toasts.length

      harness.manager.updateTaskModelBySession("ses-1", { model: "openai/gpt-5", type: "runtime-fallback" })

      expect(harness.toasts.length).toBe(before + 1)
      expect(harness.last().message).toContain("(gpt-5: deep)")
    })

    test("#then an identical model/type does not re-emit", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("m1", { sessionID: "ses-1", modelInfo: { model: "x/y", type: "user-defined" } }))
      const before = harness.toasts.length

      harness.manager.updateTaskModelBySession("ses-1", { model: "x/y", type: "user-defined" })

      expect(harness.toasts.length).toBe(before)
    })

    test("#then an unknown session is ignored", () => {
      const harness = createHarness()
      const before = harness.toasts.length
      harness.manager.updateTaskModelBySession("nope", { model: "x/y", type: "user-defined" })
      expect(harness.toasts.length).toBe(before)
    })
  })

  describe("#given removeTask", () => {
    test("#then the task leaves the running set", () => {
      const harness = createHarness()
      harness.manager.addTask(runningTask("r1"))
      harness.manager.removeTask("r1")

      expect(harness.manager.getRunningTasks()).toHaveLength(0)
    })

    test("#then a task can be moved between running and queued via updateTask", () => {
      const harness = createHarness()
      harness.manager.addTask({ ...runningTask("t1"), status: "queued" })
      expect(harness.manager.getQueuedTasks()).toHaveLength(1)

      harness.manager.updateTask("t1", "running")
      expect(harness.manager.getQueuedTasks()).toHaveLength(0)
      expect(harness.manager.getRunningTasks()).toHaveLength(1)
    })
  })

  describe("#given an empty add", () => {
    test("#then a task without an id is ignored", () => {
      const harness = createHarness()
      harness.manager.addTask({ description: "no id", agent: "atlas" })
      expect(harness.toasts).toHaveLength(0)
      expect(harness.manager.size()).toBe(0)
    })
  })

  describe("#given formatDuration", () => {
    test("#then seconds, minutes and hours format like V1", () => {
      expect(formatDuration(0, 0)).toBe("0s")
      expect(formatDuration(0, 65_000)).toBe("1m 5s")
      expect(formatDuration(0, 3_660_000)).toBe("1h 1m")
    })

    test("#then a Date start is accepted", () => {
      expect(formatDuration(new Date(0), 5_000)).toBe("5s")
    })
  })
})
