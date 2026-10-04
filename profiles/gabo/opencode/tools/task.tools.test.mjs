import { describe, expect, test } from "bun:test"
import {
  applyTaskUpdate,
  createTaskIdFactory,
  createTaskLock,
  createTaskTools,
  createV2TaskStore,
  parseTaskObject,
  resolveTaskListId,
  sanitizePathSegment,
  TASK_LIST_REMINDER,
} from "./task.tools.mjs"

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

function task(overrides = {}) {
  return {
    id: "T-seed-1",
    subject: "Seed",
    description: "",
    status: "pending",
    blocks: [],
    blockedBy: [],
    threadID: "ses_seed",
    ...overrides,
  }
}

function makeTools(storage, extra = {}) {
  const store = createV2TaskStore({ storage, listId: "default" })
  const tools = createTaskTools({
    store,
    idFactory: createTaskIdFactory({ randomUUID: (() => { let n = 0; return () => `fixed-${n++}` })() }),
    ...extra,
  })
  return { store, tools }
}

describe("task id and list-id resolution", () => {
  test("generates the T- prefixed id", () => {
    expect(createTaskIdFactory({ randomUUID: () => "abc" })()).toBe("T-abc")
  })

  test("list id precedence matches V1 and sanitizes path segments", () => {
    expect(resolveTaskListId({ env: { ULTRAWORK_TASK_LIST_ID: "a/b" }, config: {}, cwd: "/x/project" })).toBe(sanitizePathSegment("a/b"))
    expect(resolveTaskListId({ env: { CLAUDE_CODE_TASK_LIST_ID: "claude" }, config: {}, cwd: "/x/project" })).toBe("claude")
    expect(resolveTaskListId({ env: {}, config: { sisyphus: { tasks: { task_list_id: "cfg" } } }, cwd: "/x/project" })).toBe("cfg")
    expect(resolveTaskListId({ env: {}, config: {}, cwd: "/x/project" })).toBe("project")
  })
})

describe("task store over V2 storage", () => {
  test("round-trips a valid task and drops malformed values", async () => {
    const storage = memoryStorage()
    const { store } = makeTools(storage)
    await store.writeTask(task({ id: "T-a" }))
    expect((await store.readTask("T-a")).subject).toBe("Seed")
    await storage.set(store.keyFor("T-bad"), { id: "T-bad" })
    expect(await store.readTask("T-bad")).toBeNull()
  })

  test("lists only well-formed tasks under its list prefix", async () => {
    const storage = memoryStorage({
      "rigel-v2/tasks/default/T-a": task({ id: "T-a" }),
      "rigel-v2/tasks/other/T-x": task({ id: "T-x" }),
      "rigel-v2/tasks/default/T-bad": { nope: true },
    })
    const { store } = makeTools(storage)
    expect((await store.listTasks()).map((entry) => entry.id)).toEqual(["T-a"])
  })

  test("parseTaskObject requires the strict V1 field set", () => {
    expect(parseTaskObject(task())).toEqual(task())
    expect(parseTaskObject({ ...task(), extra: 1 })).toBeNull()
    expect(parseTaskObject({ id: "T-1", subject: "s" })).toBeNull()
  })
})

describe("task_create / task_get / task_list / task_update contracts", () => {
  test("create returns the minimal response and records threadID", async () => {
    const storage = memoryStorage()
    const { store, tools } = makeTools(storage)
    const result = JSON.parse(await tools.task_create.execute({ subject: "First" }, { sessionID: "ses_parent" }))
    expect(result.task).toEqual({ id: "T-fixed-0", subject: "First" })
    const stored = await store.readTask("T-fixed-0")
    expect(stored.threadID).toBe("ses_parent")
    expect(stored.status).toBe("pending")
  })

  test("create reports validation_error when subject is missing", async () => {
    const { tools } = makeTools(memoryStorage())
    const result = JSON.parse(await tools.task_create.execute({}, { sessionID: "ses" }))
    expect(result.error).toBe("validation_error")
  })

  test("create reports lock contention as retryable", async () => {
    const { tools } = makeTools(memoryStorage(), { lock: { acquire: async () => ({ acquired: false, release() {} }) } })
    const result = JSON.parse(await tools.task_create.execute({ subject: "x" }, { sessionID: "ses" }))
    expect(result).toEqual({ error: "task_lock_unavailable", retryable: true })
  })

  test("get returns the full task, null for absent, and invalid_task_id for a bad id", async () => {
    const storage = memoryStorage()
    const { store, tools } = makeTools(storage)
    const full = task({ id: "T-full", subject: "Complex", description: "d", status: "in_progress", blocks: ["T-b"], blockedBy: ["T-c"], owner: "agent", metadata: { priority: "high" } })
    await store.writeTask(full)
    expect(JSON.parse(await tools.task_get.execute({ id: "T-full" })).task).toEqual(full)
    expect(JSON.parse(await tools.task_get.execute({ id: "T-missing" })).task).toBeNull()
    expect(JSON.parse(await tools.task_get.execute({ id: "nope" })).error).toBe("invalid_task_id")
  })

  test("list excludes completed and deleted and filters unresolved blockers", async () => {
    const storage = memoryStorage()
    const { store, tools } = makeTools(storage)
    await store.writeTask(task({ id: "T-done", status: "completed" }))
    await store.writeTask(task({ id: "T-del", status: "deleted" }))
    await store.writeTask(task({ id: "T-open", blockedBy: ["T-done", "T-pending", "T-missing"] }))
    await store.writeTask(task({ id: "T-pending" }))
    const result = JSON.parse(await tools.task_list.execute())
    expect(result.reminder).toBe(TASK_LIST_REMINDER)
    expect(result.tasks.map((entry) => entry.id).sort()).toEqual(["T-open", "T-pending"])
    const open = result.tasks.find((entry) => entry.id === "T-open")
    // T-done resolves; T-pending and the absent T-missing stay unresolved.
    expect(open.blockedBy).toEqual(["T-pending", "T-missing"])
  })

  test("update applies additive and metadata-merge semantics", async () => {
    const storage = memoryStorage()
    const { store, tools } = makeTools(storage)
    await store.writeTask(task({ id: "T-u", blocks: ["T-1"], metadata: { keep: 1, drop: 2 } }))
    const result = JSON.parse(await tools.task_update.execute({
      id: "T-u",
      status: "in_progress",
      addBlocks: ["T-1", "T-2"],
      addBlockedBy: ["T-3"],
      metadata: { drop: null, added: true },
    }, { sessionID: "ses" }))
    expect(result.task.blocks).toEqual(["T-1", "T-2"])
    expect(result.task.blockedBy).toEqual(["T-3"])
    expect(result.task.metadata).toEqual({ keep: 1, added: true })
    expect(result.task.status).toBe("in_progress")
  })

  test("update returns task_not_found for an absent id and invalid_task_id for a bad one", async () => {
    const { tools } = makeTools(memoryStorage())
    expect(JSON.parse(await tools.task_update.execute({ id: "T-missing" }, {})).error).toBe("task_not_found")
    expect(JSON.parse(await tools.task_update.execute({ id: "bad" }, {})).error).toBe("invalid_task_id")
  })

  test("applyTaskUpdate dedupes additive arrays", () => {
    const next = applyTaskUpdate(task({ id: "T-z", blocks: ["a"] }), { addBlocks: ["a", "b"] })
    expect(next.blocks).toEqual(["a", "b"])
  })
})

describe("task lock", () => {
  test("reports not acquired once the wait budget is exhausted", async () => {
    const lock = createTaskLock({ waitTimeoutMs: 0, now: () => 1000, sleep: async () => {} })
    const first = await lock.acquire()
    expect(first.acquired).toBe(true)
    const second = await lock.acquire()
    expect(second.acquired).toBe(false)
    first.release()
    expect((await lock.acquire()).acquired).toBe(true)
  })
})
