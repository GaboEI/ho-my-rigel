/**
 * T22 wiring regression: the todo-continuation enforcer must be reachable from
 * the native V2 runtime's REAL `plugin.setup()` surface.
 *
 * The three modules involved are proven in isolation by their own tests:
 *   - `rigel-v2-native-todo-continuation-state.mjs` (per-session bookkeeping)
 *   - `rigel-v2-native-todo-continuation-gate.mjs`  (pure decision predicate)
 *   - `rigel-v2-todo-continuation-prompt.mjs`       (the V1 continuation text)
 *
 * This test proves the RUNTIME wires them to the real `session.idle` edge:
 *   - an idle event with incomplete todos injects the continuation prompt once;
 *   - a duplicate idle event does not inject again (cooldown / idle dedupe);
 *   - an all-completed todo list never injects;
 *   - a session stopped through `/stop-continuation` never injects.
 *
 * A regression that keeps every module but drops the event-loop call, the
 * import, or the stop flag read leaves the whole feature inert; these cases fail
 * on the base where the runtime never calls the enforcer.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import plugin from "./rigel-v2-native.mjs"
import { CONTINUATION_PROMPT_MARKER } from "./rigel-v2-todo-continuation-prompt.mjs"

const SESSION_ID = "ses_todo_continuation"
const TODO_KEY = `rigel-v2/session-todos/${SESSION_ID}`

function todoEnvelope(todos) {
  return { version: 1, todos }
}

function trackedTodo(id, status, content = `task ${id}`) {
  return { id, content, status, priority: "medium" }
}

/** The V2 storage domain the runtime's session-todo registry reads through. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : undefined
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan({ prefix = "", limit = 100, after } = {}) {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after ? keys.indexOf(after) + 1 : 0
      const slice = keys.slice(start, start + limit)
      const nextIndex = start + slice.length
      return {
        entries: slice.map((key) => ({ key, value: map.get(key) })),
        ...(nextIndex < keys.length ? { next: keys[nextIndex - 1] } : {}),
      }
    },
  }
}

/**
 * A push-driven V2 event stream. `whenNextRequested()` resolves after the
 * runtime's `for await` loop has fully processed the pushed event and asked for
 * the next one, which is the deterministic barrier the test awaits (raced
 * against an explicit timeout so a dropped event fails loudly instead of
 * hanging).
 */
function createEventStream() {
  const queue = []
  let pendingResolve = null
  let closed = false
  let nextRequestedResolvers = []

  function settle() {
    if (!pendingResolve) return
    if (queue.length > 0) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve({ value: queue.shift(), done: false })
    } else if (closed) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve({ value: undefined, done: true })
    }
  }

  function noteNextRequested() {
    const resolvers = nextRequestedResolvers
    nextRequestedResolvers = []
    for (const resolve of resolvers) resolve()
  }

  return {
    push(event) {
      queue.push(event)
      settle()
    },
    close() {
      closed = true
      settle()
    },
    whenNextRequested({ timeoutMs = 2000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for the event loop to process the pushed event")),
          timeoutMs,
        )
        nextRequestedResolvers.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          noteNextRequested()
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            pendingResolve = resolve
          })
        },
        return() {
          closed = true
          settle()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

/**
 * A minimal but real V2 setup context: the storage domain the todo registry
 * persists through, a controllable event stream, a `session.hook` recorder so
 * the test can drive the real `/stop-continuation` admission path, and a
 * `session.prompt` recorder so it can count/observe the injections. The
 * `location.directory` is a real temp dir so the stop marker write is scoped
 * and removable.
 */
function createRuntimeHarness({ todos, agent, messages } = {}) {
  const added = new Map()
  const sessionHooks = new Map()
  const promptCalls = []
  const storage = memoryStorage(todos ? { [TODO_KEY]: todoEnvelope(todos) } : {})
  const events = createEventStream()
  const directory = mkdtempSync(join(tmpdir(), "rigel-v2-todo-cont-"))
  const defaultMessages = [{ id: "m1", role: "user", time: { created: 1 }, parts: [{ type: "text", text: "hello" }] }]
  const context = {
    location: { directory },
    storage,
    config: {},
    session: {
      hook: async (name, handler) => {
        sessionHooks.set(name, handler)
        return { dispose() {} }
      },
      get: async ({ sessionID }) => ({ data: sessionID === SESSION_ID ? { id: sessionID, ...(agent ? { agent } : {}) } : undefined }),
      context: async ({ sessionID }) => ({
        data: sessionID === SESSION_ID ? (messages ?? defaultMessages) : [],
      }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async (input) => {
        promptCalls.push(input)
        return { data: {} }
      },
    },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => {
        callback({ update() {}, default() {} })
        return { dispose() {} }
      },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    event: {
      subscribe: ({ signal } = {}) => {
        if (signal?.aborted) events.close()
        else signal?.addEventListener?.("abort", () => events.close(), { once: true })
        return events
      },
    },
    tool: {
      transform: async (callback) => {
        await callback({
          add: (definition) => {
            if (definition?.name) added.set(definition.name, definition)
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  return { context, added, sessionHooks, storage, events, promptCalls, directory }
}

/** Push one idle event and wait until the runtime's loop has processed it. */
async function pushIdle(events) {
  const advanced = events.whenNextRequested()
  events.push({ type: "session.idle", data: { sessionID: SESSION_ID } })
  await advanced
}

/** Push a non-idle event and wait until the runtime's loop has processed it. */
async function pushEvent(events, event) {
  const advanced = events.whenNextRequested()
  events.push({ type: event.type, data: { sessionID: SESSION_ID, ...event.data } })
  await advanced
}

async function withHarness(options, run) {
  const harness = createRuntimeHarness(options)
  const dispose = await plugin.setup(harness.context)
  try {
    await run(harness)
  } finally {
    await dispose()
    harness.events.close()
    rmSync(harness.directory, { recursive: true, force: true })
  }
}

describe("#given the native V2 runtime with the todo-continuation enforcer wired", () => {
  test("#when an idle event arrives with incomplete todos #then it injects the continuation once", async () => {
    await withHarness({ todos: [trackedTodo("a", "pending"), trackedTodo("b", "in_progress")] }, async ({ events, promptCalls }) => {
      // when
      await pushIdle(events)
      // then
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0].sessionID).toBe(SESSION_ID)
      expect(promptCalls[0].text).toContain(CONTINUATION_PROMPT_MARKER)
      expect(promptCalls[0].text).toContain("task a")
    })
  })

  test("#when duplicate idle events arrive #then only the first injects", async () => {
    await withHarness({ todos: [trackedTodo("a", "pending")] }, async ({ events, promptCalls }) => {
      // when
      await pushIdle(events)
      await pushIdle(events)
      // then
      expect(promptCalls).toHaveLength(1)
    })
  })

  test("#when every todo is completed #then it never injects", async () => {
    await withHarness({ todos: [trackedTodo("a", "completed"), trackedTodo("b", "completed")] }, async ({ events, promptCalls }) => {
      // when
      await pushIdle(events)
      // then
      expect(promptCalls).toHaveLength(0)
    })
  })

  test("#when the session was stopped #then a later idle never injects", async () => {
    await withHarness({ todos: [trackedTodo("a", "pending")] }, async ({ events, sessionHooks, promptCalls }) => {
      // given: the real `/stop-continuation` admission path marks the session stopped
      const promptHook = sessionHooks.get("prompt")
      expect(typeof promptHook, "the runtime must register the prompt admission hook").toBe("function")
      await promptHook({ sessionID: SESSION_ID, prompt: { text: "/stop-continuation" } })

      // when
      await pushIdle(events)

      // then
      expect(promptCalls).toHaveLength(0)
    })
  })

  test("#when the transcript holds an open question #then it never injects", async () => {
    const messages = [{ type: "assistant", content: [{ type: "tool", name: "question", state: { status: "running" } }] }]
    await withHarness({ todos: [trackedTodo("a", "pending")], messages }, async ({ events, promptCalls }) => {
      // when
      await pushIdle(events)
      // then: the runtime read the real transcript (getMessages is wired)
      expect(promptCalls).toHaveLength(0)
    })
  })

  test("#when the transcript question is answered #then it injects", async () => {
    const messages = [{ type: "assistant", content: [{ type: "tool", name: "question", state: { status: "completed" } }] }]
    await withHarness({ todos: [trackedTodo("a", "pending")], messages }, async ({ events, promptCalls }) => {
      // when
      await pushIdle(events)
      // then
      expect(promptCalls).toHaveLength(1)
    })
  })

  test("#when the owning agent is in the skip list #then it never injects", async () => {
    await withHarness({ todos: [trackedTodo("a", "pending")], agent: "prometheus" }, async ({ events, promptCalls }) => {
      // when
      await pushIdle(events)
      // then: the runtime resolved the real agent (resolveAgent is wired)
      expect(promptCalls).toHaveLength(0)
    })
  })

  test("#when an abort error was observed #then a later idle never injects", async () => {
    await withHarness({ todos: [trackedTodo("a", "pending")] }, async ({ events, promptCalls }) => {
      // given: the runtime observed a real abort error event (onEvent is wired)
      await pushEvent(events, { type: "session.error", data: { error: { name: "MessageAbortedError" } } })
      // when
      await pushIdle(events)
      // then
      expect(promptCalls).toHaveLength(0)
    })
  })

  test("#when a compaction armed the guard #then a later idle never injects", async () => {
    await withHarness({ todos: [trackedTodo("a", "pending")] }, async ({ events, promptCalls }) => {
      // given
      await pushEvent(events, { type: "session.compacted", data: {} })
      // when
      await pushIdle(events)
      // then
      expect(promptCalls).toHaveLength(0)
    })
  })
})
