import { describe, expect, test } from "bun:test"
import {
  buildConditionalToolDefinitions,
  readMaterializedGates,
  registerConditionalNativeTools,
} from "./rigel-v2-native-conditional-tools.mjs"
import { TASK_TOOL_NAMES } from "./tools/task.tools.mjs"
import { GOAL_TOOL_NAMES } from "./tools/goal.tools.mjs"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan({ prefix = "" } = {}) {
      return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  }
}

function fakeContext({ storage, pty, onSubscription } = {}) {
  const added = []
  let disposedTransform = false
  return {
    added,
    transformDisposed: () => disposedTransform,
    context: {
      location: { directory: "/work" },
      ...(storage ? { storage } : {}),
      ...(pty ? { pty } : {}),
      tool: {
        transform: async (callback) => {
          callback({ add: (definition) => added.push(definition.name) })
          return { dispose: async () => { disposedTransform = true } }
        },
      },
      session: { prompt: async () => ({ data: {} }) },
      event: {
        subscribe: ({ signal } = {}) => ({
          async *[Symbol.asyncIterator]() {
            if (!signal) return
            onSubscription?.()
            await new Promise((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", resolve, { once: true })
            })
          },
        }),
      },
    },
  }
}

const GATE_OFF = { interactive_bash: false, task_system: false, goal: false, monitor: false }

describe("gate reader", () => {
  test("defaults every gate to false and only accepts explicit true", () => {
    expect(readMaterializedGates(undefined)).toEqual(GATE_OFF)
    expect(readMaterializedGates({ metadata: { global: { gates: { task_system: "yes", goal: 1 } } } })).toEqual(GATE_OFF)
    expect(readMaterializedGates({ metadata: { global: { gates: { task_system: true, goal: true } } } })).toEqual({ ...GATE_OFF, task_system: true, goal: true })
  })
})

describe("conditional tool definitions", () => {
  test("returns nothing when every gate is off", () => {
    const result = buildConditionalToolDefinitions({ gates: GATE_OFF, tmuxPath: "/usr/bin/tmux", ptyRunner: { run: async () => {} }, taskStore: {}, goalStore: {} })
    expect(result).toEqual({ definitions: {}, names: [] })
  })

  test("builds each family only when its gate and backend are present", () => {
    const taskStore = { readTask: async () => null, writeTask: async () => {}, listTasks: async () => [] }
    const goalStore = { readGoal: async () => null, writeGoal: async () => {}, createGoal: async () => {}, updateGoal: async () => null, clearGoal: async () => false }
    const task = buildConditionalToolDefinitions({ gates: { ...GATE_OFF, task_system: true }, taskStore })
    expect(task.names).toEqual(TASK_TOOL_NAMES)
    const goal = buildConditionalToolDefinitions({ gates: { ...GATE_OFF, goal: true }, goalStore })
    expect(goal.names).toEqual(GOAL_TOOL_NAMES)
    const bash = buildConditionalToolDefinitions({ gates: { ...GATE_OFF, interactive_bash: true }, tmuxPath: "/usr/bin/tmux", ptyRunner: { run: async () => {} } })
    expect(bash.names).toEqual(["interactive_bash"])
  })

  test("reports an enabled gate with no backend instead of registering a fake", () => {
    const unavailable = []
    const result = buildConditionalToolDefinitions({
      gates: { ...GATE_OFF, task_system: true, goal: true, interactive_bash: true },
      onUnavailable: (family, reason) => unavailable.push([family, reason]),
    })
    expect(result.names).toEqual([])
    expect(unavailable.map(([family]) => family).sort()).toEqual(["goal", "interactive_bash", "task_system"])
  })
})

describe("registration on the V2 host", () => {
  test("registers nothing and never transforms tools when every gate is off", async () => {
    const fake = fakeContext({ storage: memoryStorage(), pty: { create: async () => ({ data: { id: "p" } }), remove: async () => {} } })
    const result = await registerConditionalNativeTools({ context: fake.context, manifest: {}, log: () => {} })
    expect(result.registered).toEqual([])
    expect(fake.added).toEqual([])
    await result.dispose()
  })

  test("registers the task family when the manifest gate is enabled", async () => {
    const fake = fakeContext({ storage: memoryStorage() })
    const result = await registerConditionalNativeTools({
      context: fake.context,
      manifest: { metadata: { global: { gates: { task_system: true } } } },
      log: () => {},
    })
    expect(fake.added.sort()).toEqual([...TASK_TOOL_NAMES].sort())
    expect(result.registered).toHaveLength(4)
    await result.dispose()
    expect(fake.transformDisposed()).toBe(true)
  })

  test("keeps a gate-enabled family unregistered when its V2 domain is absent", async () => {
    const fake = fakeContext({})
    const result = await registerConditionalNativeTools({
      context: fake.context,
      manifest: {},
      gates: { task_system: true },
      log: () => {},
    })
    expect(fake.added).toEqual([])
    expect(result.unavailable.map((entry) => entry.family)).toEqual(["task_system"])
  })

  test("registers interactive_bash only with both an enabled gate and a real tmux path", async () => {
    const pty = { create: async () => ({ data: { id: "p" } }), remove: async () => {} }
    const enabled = fakeContext({ pty })
    const withTmux = await registerConditionalNativeTools({
      context: enabled.context,
      manifest: {},
      gates: { interactive_bash: true },
      tmuxPath: "/usr/bin/tmux",
      log: () => {},
    })
    expect(withTmux.registered).toEqual(["interactive_bash"])
    await withTmux.dispose()

    const disabled = fakeContext({ pty })
    const withoutTmux = await registerConditionalNativeTools({
      context: disabled.context,
      manifest: {},
      gates: { interactive_bash: true },
      tmuxPath: "",
      log: () => {},
    })
    expect(withoutTmux.registered).toEqual([])
    expect(disabled.added).toEqual([])
  })

  test("subscribes the goal continuation and aborts it on dispose", async () => {
    let subscriptions = 0
    const fake = fakeContext({ storage: memoryStorage(), onSubscription: () => { subscriptions += 1 } })
    const result = await registerConditionalNativeTools({
      context: fake.context,
      manifest: {},
      gates: { goal: true },
      log: () => {},
    })
    expect(fake.added.sort()).toEqual([...GOAL_TOOL_NAMES].sort())
    expect(subscriptions).toBe(1)
    await result.dispose()
  })
})
