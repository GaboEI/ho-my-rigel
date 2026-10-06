/**
 * Fase 3 T5b wiring regression (T22).
 *
 * The task system and the `session_*` tools share ONE per-session todo registry
 * owned by the runtime (`createV2SessionTodoStore`). The equivalence only holds
 * when `rigel-v2-native.mjs` forwards the reader/writer into the two
 * registration seams:
 *   - `readTodos`  -> `createNativeToolFamilies()`  -> `session_info`/`session_read`
 *   - `syncTodos`  -> `registerConditionalNativeTools()` -> `task_create`/`task_update`
 *
 * A regression dropped those two arguments while keeping the store declarations,
 * so every task silently vanished from the session surface. This test drives the
 * REAL `plugin.setup()` through a V2 storage-backed context with the
 * `task_system` gate enabled and asserts the observable chain end to end:
 * `task_create` mirrors into the registry and `session_info` reads it back. It
 * fails on the base where the runtime never forwards the seam.
 */
import { afterEach, describe, expect, test } from "bun:test"
import plugin from "./rigel-v2-native.mjs"
import manifest from "./rigel-v2-native-agent-manifest.mjs"

const SESSION_ID = "ses_todo_wiring"

// The source manifest is the install-time placeholder (all gates off), so the
// task family never registers with it. Flip the one gate this regression needs
// and restore the exact reference afterwards so no sibling test inherits it.
const ORIGINAL_MANIFEST_METADATA = manifest.metadata
function enableTaskGate() {
  manifest.metadata = { global: { gates: { task_system: true } } }
}
afterEach(() => {
  manifest.metadata = ORIGINAL_MANIFEST_METADATA
})

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
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

// A minimal but real V2 setup context: the storage domain the todo registry
// persists through, the one session the scoped reads resolve, and a
// `tool.transform` that captures every registered definition by name so the
// test can invoke the real tools the runtime built.
function createRuntimeHarness() {
  const added = new Map()
  const context = {
    location: { directory: "/native-v2-todo-wiring" },
    storage: memoryStorage(),
    session: {
      hook: async () => ({ dispose() {} }),
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
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    tool: {
      transform: async (callback) => {
        await callback({
          add: (definition) => { if (definition?.name) added.set(definition.name, definition) },
        })
        return { dispose: async () => {} }
      },
    },
  }
  return { context, added }
}

// Core session tools return a raw string; conditional task tools are normalized
// to `{ content }` by `normalizeToolDefinition`. Unwrap either shape.
function resultText(result) {
  if (typeof result === "string") return result
  if (result && typeof result.content === "string") return result.content
  return String(result)
}

describe("#given the native V2 runtime with a storage-backed todo registry", () => {
  test("#when a task is created and the session inspected #then the todo is mirrored and read back", async () => {
    // given
    enableTaskGate()
    const { context, added } = createRuntimeHarness()
    const dispose = await plugin.setup(context)
    try {
      const taskCreate = added.get("task_create")
      const sessionInfo = added.get("session_info")
      const sessionRead = added.get("session_read")
      expect(taskCreate, "task_create must be registered by the conditional family").toBeDefined()
      expect(sessionInfo, "session_info must be registered by the session family").toBeDefined()
      expect(sessionRead, "session_read must be registered by the session family").toBeDefined()

      // when
      const created = await taskCreate.execute({ subject: "wire the todo mirror" }, { sessionID: SESSION_ID })

      // then: the task tool mirrored into the shared registry
      expect(resultText(created)).toContain("wire the todo mirror")
      const info = resultText(await sessionInfo.execute({ session_id: SESSION_ID }))
      expect(info).toContain("Has Todos: Yes (1 items)")
      const read = resultText(await sessionRead.execute({ session_id: SESSION_ID, include_todos: true }))
      expect(read).toContain("wire the todo mirror")
    } finally {
      await dispose()
    }
  })

  test("#when a task is deleted #then the mirror drops the todo from the session surface", async () => {
    // given
    enableTaskGate()
    const { context, added } = createRuntimeHarness()
    const dispose = await plugin.setup(context)
    try {
      const taskCreate = added.get("task_create")
      const taskUpdate = added.get("task_update")
      const sessionInfo = added.get("session_info")
      const created = JSON.parse(resultText(await taskCreate.execute({ subject: "transient todo" }, { sessionID: SESSION_ID })))
      const before = resultText(await sessionInfo.execute({ session_id: SESSION_ID }))
      expect(before).toContain("Has Todos: Yes (1 items)")
      // when
      await taskUpdate.execute({ id: created.task.id, status: "deleted" }, { sessionID: SESSION_ID })
      // then
      const info = resultText(await sessionInfo.execute({ session_id: SESSION_ID }))
      expect(info).toContain("Has Todos: No")
    } finally {
      await dispose()
    }
  })
})
