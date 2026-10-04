import { describe, expect, test } from "bun:test"
import {
  createTaskTodoSync,
  createV2SessionTodoStore,
  extractPriority,
  mapTaskStatusToTodoStatus,
  parseTodoEnvelope,
  parseTodoInfo,
  syncTaskToTodo,
  todosMatch,
} from "./session-todo-store.mjs"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
  }
}

function task(overrides = {}) {
  return {
    id: "T-1",
    subject: "Seed task",
    description: "",
    status: "pending",
    blocks: [],
    blockedBy: [],
    threadID: "ses_1",
    ...overrides,
  }
}

describe("pure task to todo mappers", () => {
  test("mapTaskStatusToTodoStatus mirrors V1, deleted yields null", () => {
    expect(mapTaskStatusToTodoStatus("pending")).toBe("pending")
    expect(mapTaskStatusToTodoStatus("in_progress")).toBe("in_progress")
    expect(mapTaskStatusToTodoStatus("completed")).toBe("completed")
    expect(mapTaskStatusToTodoStatus("deleted")).toBeNull()
    expect(mapTaskStatusToTodoStatus("bogus")).toBe("pending")
  })

  test("extractPriority accepts only low/medium/high strings", () => {
    expect(extractPriority({ priority: "high" })).toBe("high")
    expect(extractPriority({ priority: "low" })).toBe("low")
    expect(extractPriority({ priority: 5 })).toBeUndefined()
    expect(extractPriority({ priority: "urgent" })).toBeUndefined()
    expect(extractPriority(undefined)).toBeUndefined()
  })

  test("syncTaskToTodo maps the V1 todo shape and defaults priority to medium", () => {
    expect(syncTaskToTodo(task({ id: "T-a", subject: "Alpha", status: "in_progress" }))).toEqual({
      id: "T-a",
      content: "Alpha",
      status: "in_progress",
      priority: "medium",
    })
    expect(syncTaskToTodo(task({ metadata: { priority: "high" } }))).toEqual({
      id: "T-1",
      content: "Seed task",
      status: "pending",
      priority: "high",
    })
    expect(syncTaskToTodo(task({ status: "deleted" }))).toBeNull()
  })

  test("todosMatch prefers ids, falls back to content", () => {
    expect(todosMatch({ id: "a", content: "x" }, { id: "a", content: "y" })).toBe(true)
    expect(todosMatch({ id: "a", content: "x" }, { id: "b", content: "x" })).toBe(false)
    expect(todosMatch({ content: "x" }, { content: "x" })).toBe(true)
    expect(todosMatch({ content: "x" }, { content: "y" })).toBe(false)
  })
})

describe("session todo store over V2 storage", () => {
  test("round-trips a written todo list through the envelope", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    const todos = [{ id: "T-1", content: "Seed task", status: "pending", priority: "medium" }]
    await store.writeTodos("ses_1", todos)
    expect(await store.readTodos("ses_1")).toEqual(todos)
    expect(storage.map.get(store.keyFor("ses_1"))).toEqual({ version: 1, todos })
  })

  test("keys are namespaced by prefix and session id", () => {
    const store = createV2SessionTodoStore({ storage: memoryStorage(), prefix: "custom/todos" })
    expect(store.keyFor("ses_9")).toBe("custom/todos/ses_9")
  })

  test("requires the storage domain with get and set", () => {
    expect(() => createV2SessionTodoStore({})).toThrow(TypeError)
    expect(() => createV2SessionTodoStore({ storage: { get() {} } })).toThrow(TypeError)
  })

  test("malformed stored values resolve to an empty list", async () => {
    const storage = memoryStorage({
      "rigel-v2/session-todos/ses_bad": "not-an-object",
      "rigel-v2/session-todos/ses_arr": [{ content: "x", status: "pending" }],
      "rigel-v2/session-todos/ses_ver": { version: 99, todos: [] },
      "rigel-v2/session-todos/ses_todos": { version: 1, todos: "nope" },
      "rigel-v2/session-todos/ses_entries": { version: 1, todos: [{ content: "x" }, 5, null] },
    })
    const store = createV2SessionTodoStore({ storage })
    expect(await store.readTodos("ses_bad")).toEqual([])
    expect(await store.readTodos("ses_arr")).toEqual([])
    expect(await store.readTodos("ses_ver")).toEqual([])
    expect(await store.readTodos("ses_todos")).toEqual([])
    expect(await store.readTodos("ses_entries")).toEqual([])
    expect(await store.readTodos("ses_absent")).toEqual([])
  })

  test("parseTodoEnvelope and parseTodoInfo drop invalid entries only", () => {
    expect(parseTodoEnvelope({ version: 1, todos: [{ content: "x", status: "pending" }, { content: "y" }] })).toEqual([
      { content: "x", status: "pending" },
    ])
    expect(parseTodoInfo({ content: "x", status: "bogus" })).toBeNull()
    expect(parseTodoInfo({ content: "x", status: "completed", priority: "nope" })).toBeNull()
    expect(parseTodoInfo({ content: "x", status: "completed", priority: "high" })).toEqual({
      content: "x",
      status: "completed",
      priority: "high",
    })
  })
})

describe("task to session todo sync", () => {
  test("create upserts the mapped todo by task id", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-1", subject: "First" }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([
      { id: "T-1", content: "First", status: "pending", priority: "medium" },
    ])
    await sync.syncTodos(task({ id: "T-1", subject: "First renamed" }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([
      { id: "T-1", content: "First renamed", status: "pending", priority: "medium" },
    ])
  })

  test("update changes status without duplicating the row", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-1", subject: "First" }), "ses_1")
    await sync.syncTodos(task({ id: "T-1", subject: "First", status: "in_progress" }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([
      { id: "T-1", content: "First", status: "in_progress", priority: "medium" },
    ])
  })

  test("delete removes the matching todo", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-1", subject: "First" }), "ses_1")
    await sync.syncTodos(task({ id: "T-1", subject: "First", status: "deleted" }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([])
  })

  test("delete falls back to content matching for a todo without an id", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    await store.writeTodos("ses_1", [{ content: "First", status: "pending" }])
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-1", subject: "First", status: "deleted" }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([])
  })

  test("a second task is added without dropping the first", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-1", subject: "First" }), "ses_1")
    await sync.syncTodos(task({ id: "T-2", subject: "Second", metadata: { priority: "high" } }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([
      { id: "T-1", content: "First", status: "pending", priority: "medium" },
      { id: "T-2", content: "Second", status: "pending", priority: "high" },
    ])
  })

  test("sessions are isolated from each other", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-1", subject: "First" }), "ses_a")
    await sync.syncTodos(task({ id: "T-2", subject: "Second" }), "ses_b")
    expect(await store.readTodos("ses_a")).toEqual([
      { id: "T-1", content: "First", status: "pending", priority: "medium" },
    ])
    expect(await store.readTodos("ses_b")).toEqual([
      { id: "T-2", content: "Second", status: "pending", priority: "medium" },
    ])
  })

  test("priority comes from task metadata when valid, else medium", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-low", subject: "Low", metadata: { priority: "low" } }), "ses_1")
    await sync.syncTodos(task({ id: "T-mid", subject: "Mid" }), "ses_1")
    await sync.syncTodos(task({ id: "T-bad", subject: "Bad", metadata: { priority: "urgent" } }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([
      { id: "T-low", content: "Low", status: "pending", priority: "low" },
      { id: "T-mid", content: "Mid", status: "pending", priority: "medium" },
      { id: "T-bad", content: "Bad", status: "pending", priority: "medium" },
    ])
  })

  test("preserves unrelated existing todos", async () => {
    const storage = memoryStorage()
    const store = createV2SessionTodoStore({ storage })
    await store.writeTodos("ses_1", [{ id: "T-keep", content: "Untouched", status: "completed", priority: "low" }])
    const sync = createTaskTodoSync({ store })
    await sync.syncTodos(task({ id: "T-1", subject: "First" }), "ses_1")
    expect(await store.readTodos("ses_1")).toEqual([
      { id: "T-keep", content: "Untouched", status: "completed", priority: "low" },
      { id: "T-1", content: "First", status: "pending", priority: "medium" },
    ])
  })

  test("requires a store with readTodos and writeTodos", () => {
    expect(() => createTaskTodoSync({})).toThrow(TypeError)
  })
})
