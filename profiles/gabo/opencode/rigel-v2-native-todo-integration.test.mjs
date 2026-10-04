/**
 * Fase 3 T5b integration: the task system and the session_* tools must share one
 * real per-session todo registry, so a created task becomes a visible session
 * todo. This is the observable equivalence that replaces the audit's constant
 * `todos: []` / `has_todos: false` placeholder.
 */
import { describe, expect, test } from "bun:test"
import { createV2SessionTodoStore, createTaskTodoSync } from "./tools/session-todo-store.mjs"
import { createV2TaskStore, createTaskTools } from "./tools/task.tools.mjs"
import { createSessionTools } from "./tools/session.tools.mjs"

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

function sessionClient() {
  return {
    session: {
      get: async ({ sessionID }) => ({ data: sessionID === "ses_1" ? { id: "ses_1" } : undefined }),
      context: async ({ sessionID }) => ({
        data: sessionID === "ses_1"
          ? [{ id: "m1", role: "user", time: { created: 1 }, parts: [{ type: "text", text: "hi" }] }]
          : [],
      }),
    },
  }
}

function wire() {
  const storage = memoryStorage()
  const taskStore = createV2TaskStore({ storage, listId: "proj" })
  const todoStore = createV2SessionTodoStore({ storage })
  const { syncTodos } = createTaskTodoSync({ store: todoStore })
  const tasks = createTaskTools({ store: taskStore, syncTodos })
  const sessions = createSessionTools({
    clients: [sessionClient()],
    directory: "/work",
    readTodos: (sessionID) => todoStore.readTodos(sessionID),
  })
  return { tasks, sessions, todoStore }
}

describe("#given a task created through the native task tools", () => {
  test("#when the session is inspected #then the todo appears in session_read and session_info", async () => {
    // given
    const { tasks, sessions } = wire()
    // when
    const created = await tasks.task_create.execute({ subject: "ship the mirror" }, { sessionID: "ses_1" })
    // then
    expect(JSON.parse(created).task.subject).toBe("ship the mirror")

    const info = await sessions.session_info.execute({ session_id: "ses_1" })
    expect(info).toContain("Has Todos: Yes (1 items)")

    const read = await sessions.session_read.execute({ session_id: "ses_1", include_todos: true })
    expect(read).toContain("=== Todos ===")
    expect(read).toContain("ship the mirror")
  })

  test("#when the task is deleted #then the todo disappears from the session registry", async () => {
    // given
    const { tasks, sessions } = wire()
    const created = JSON.parse(await tasks.task_create.execute({ subject: "ship the mirror" }, { sessionID: "ses_1" }))
    // when
    await tasks.task_update.execute({ id: created.task.id, status: "deleted" }, { sessionID: "ses_1" })
    // then
    const info = await sessions.session_info.execute({ session_id: "ses_1" })
    expect(info).toContain("Has Todos: No")
  })
})
