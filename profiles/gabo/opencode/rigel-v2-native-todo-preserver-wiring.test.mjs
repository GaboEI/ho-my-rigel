/**
 * T22 wiring regression: the compaction todo-preserver must be reachable from
 * the native V2 runtime's REAL `plugin.setup()` surface.
 *
 * The preserver module (`rigel-v2-native-compaction-todo-preserver.mjs`) is
 * proven in isolation by its own test. This test proves the RUNTIME wires it:
 *   - the `compaction` hook snapshots the detailed todos (capture) before the
 *     summary request, then still injects the compaction context;
 *   - a `session.compacted` / `session.compaction.ended` event restores the
 *     snapshot into the storage-backed registry (restore);
 *   - a late all-Atlas-bootstrap `todowrite` is replaced by the protected
 *     snapshot instead of erasing the restored work (beforeTodoWrite).
 *
 * A regression dropped the import / the capture call / the restore branch / the
 * `beforeWrite` argument while keeping the module, so this test drives the real
 * setup context and asserts the observable end-to-end chain through the store
 * the runtime owns.
 */
import { describe, expect, test } from "bun:test"
import plugin from "./rigel-v2-native.mjs"
import { ATLAS_BOOTSTRAP_TODOS } from "./rigel-v2-native-compaction-todo-preserver.mjs"

const SESSION_ID = "ses_todo_preserver"
const TODO_KEY = `rigel-v2/session-todos/${SESSION_ID}`

// The exact Atlas bootstrap table the preserver guards against, plus one real
// detailed todo that must survive compaction.
const BOOTSTRAP_TODOS = ATLAS_BOOTSTRAP_TODOS.map(({ id, content }) => ({
  id,
  content,
  status: "pending",
  priority: "medium",
}))
const DETAILED_TODO = {
  id: "detail-1",
  content: "Investigate the failing compaction test",
  status: "in_progress",
  priority: "high",
}

function todoEnvelope(todos) {
  return { version: 1, todos }
}

/**
 * A storage domain shaped like the V2 one the runtime consumes, plus a call log
 * so the test can prove the preserver read the registry through the real store.
 */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  const calls = []
  return {
    map,
    calls,
    async get(key) {
      const value = map.has(key) ? map.get(key) : undefined
      calls.push({ op: "get", key, value })
      return value
    },
    async set(key, value) {
      map.set(key, value)
      calls.push({ op: "set", key, value })
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
 * persists through, a controllable event stream, a `session.hook` recorder, and
 * a `tool.transform` that captures every registered definition by name.
 *
 * The recorder keeps the LAST handler per event name. The runtime registers its
 * compaction wrapper (capture + context) AFTER `claudeCodeHooks.install()` has
 * registered the Claude Code `PreCompact` bridge, so the last `compaction`
 * handler is the runtime wrapper under test; calling it avoids dispatching the
 * user's own Claude Code shell hooks.
 */
function createRuntimeHarness({ initialTodos } = {}) {
  const added = new Map()
  const sessionHooks = new Map()
  const storage = memoryStorage(initialTodos ? { [TODO_KEY]: todoEnvelope(initialTodos) } : {})
  const events = createEventStream()
  const context = {
    location: { directory: "/native-v2-todo-preserver-wiring" },
    storage,
    config: {},
    session: {
      hook: async (name, handler) => {
        sessionHooks.set(name, handler)
        return { dispose() {} }
      },
      get: async ({ sessionID }) => ({ data: sessionID === SESSION_ID ? { id: sessionID } : undefined }),
      context: async ({ sessionID }) => ({
        data: sessionID === SESSION_ID
          ? [{ id: "m1", role: "user", time: { created: 1 }, parts: [{ type: "text", text: "hello" }] }]
          : [],
      }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
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
  return { context, added, sessionHooks, storage, events }
}

function resultText(result) {
  if (typeof result === "string") return result
  if (result && typeof result.content === "string") return result.content
  return String(result)
}

/** Run the runtime's compaction hook over one summary request. */
async function runCompactionHook(sessionHooks, storage) {
  const compactionHook = sessionHooks.get("compaction")
  expect(typeof compactionHook, "the runtime compaction hook must be registered").toBe("function")
  const before = storage.calls.length
  const event = { sessionID: SESSION_ID, messages: [] }
  await compactionHook(event)
  return { event, before }
}

/** Capture a snapshot, empty the registry (as a summary does), then restore. */
async function captureEmptyThenRestore({ sessionHooks, storage, events }, eventType) {
  await runCompactionHook(sessionHooks, storage)
  await storage.set(TODO_KEY, todoEnvelope([]))
  const advanced = events.whenNextRequested()
  events.push({ type: eventType, data: { sessionID: SESSION_ID } })
  await advanced
}

describe("#given the native V2 runtime with the compaction todo-preserver wired", () => {
  test("#when the compaction hook runs #then it captures the detailed todos and still injects context", async () => {
    // given
    const { context, sessionHooks, storage } = createRuntimeHarness({ initialTodos: [DETAILED_TODO] })
    const dispose = await plugin.setup(context)
    try {
      // when
      const { event, before } = await runCompactionHook(sessionHooks, storage)
      // then: capture read the session registry through the real store
      const reads = storage.calls.slice(before).filter((call) => call.op === "get" && call.key === TODO_KEY)
      expect(reads.length).toBeGreaterThan(0)
      // then: the context injection still ran on the same hook
      expect(event.messages).toHaveLength(1)
      expect(event.messages[0].role).toBe("user")
      expect(Array.isArray(event.messages[0].content)).toBe(true)
    } finally {
      await dispose()
    }
  })

  for (const eventType of ["session.compacted", "session.compaction.ended"]) {
    test(`#when ${eventType} arrives #then the preserver restores the snapshot into the store`, async () => {
      // given
      const { context, sessionHooks, storage, events } = createRuntimeHarness({ initialTodos: [DETAILED_TODO] })
      const dispose = await plugin.setup(context)
      try {
        // when
        await captureEmptyThenRestore({ sessionHooks, storage, events }, eventType)
        // then
        expect(storage.map.get(TODO_KEY).todos).toEqual([DETAILED_TODO])
      } finally {
        await dispose()
      }
    })
  }

  test("#when a late all-bootstrap todowrite runs #then the protected snapshot is written instead", async () => {
    // given
    const { context, added, sessionHooks, storage, events } = createRuntimeHarness({ initialTodos: [DETAILED_TODO] })
    const dispose = await plugin.setup(context)
    try {
      await captureEmptyThenRestore({ sessionHooks, storage, events }, "session.compacted")
      const todowrite = added.get("todowrite")
      expect(todowrite, "the runtime must register the real todowrite tool").toBeDefined()

      // when: a bootstrap-only write arrives after the restore
      const result = await todowrite.execute({ todos: BOOTSTRAP_TODOS }, { sessionID: SESSION_ID })

      // then: the guard wrote the protected detailed snapshot, not the bootstrap list
      expect(storage.map.get(TODO_KEY).todos).toEqual([DETAILED_TODO])
      const text = resultText(result)
      expect(text).toContain(DETAILED_TODO.content)
      expect(text).not.toContain(BOOTSTRAP_TODOS[0].content)
    } finally {
      await dispose()
    }
  })
})
