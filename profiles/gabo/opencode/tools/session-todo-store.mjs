/**
 * Runtime-owned per-session todo registry for OpenCode V2.
 *
 * OpenCode V2 has no native session todo API (`session.todo`), so the
 * Session/todo equivalence that V1 relied on has no host surface. This module
 * provides a storage-backed registry that the V2 runtime owns, plus the V1
 * task -> todo mirror semantics ported from
 * `packages/omo-opencode/src/tools/task/todo-sync.ts`.
 *
 * Self-contained by design: this port carries plain JSON logic and imports
 * nothing from `packages/`. Every observable contract (tolerant reads, upsert
 * by id with a content fallback, preserved unrelated todos, priority mapping)
 * is mirrored from the V1 source.
 */

const TODO_STATUS_VALUES = ["pending", "in_progress", "completed", "cancelled"]
const TODO_PRIORITY_VALUES = ["low", "medium", "high"]
const TODO_ENVELOPE_VERSION = 1

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * V1 `mapTaskStatusToTodoStatus`. `deleted` maps to null (remove the todo);
 * any unknown status maps to `pending`.
 */
export function mapTaskStatusToTodoStatus(taskStatus) {
  switch (taskStatus) {
    case "pending":
      return "pending"
    case "in_progress":
      return "in_progress"
    case "completed":
      return "completed"
    case "deleted":
      return null
    default:
      return "pending"
  }
}

/**
 * V1 `extractPriority`. Only the literal low/medium/high strings qualify;
 * anything else (including a number) yields undefined.
 */
export function extractPriority(metadata) {
  if (!metadata) return undefined
  const priority = metadata.priority
  if (typeof priority === "string" && TODO_PRIORITY_VALUES.includes(priority)) {
    return priority
  }
  return undefined
}

/**
 * V1 `syncTaskToTodo`. Returns the mapped todo, or null for a deleted task.
 */
export function syncTaskToTodo(task) {
  const todoStatus = mapTaskStatusToTodoStatus(task.status)
  if (todoStatus === null) return null
  return {
    id: task.id,
    content: task.subject,
    status: todoStatus,
    priority: extractPriority(task.metadata) ?? "medium",
  }
}

/**
 * V1 `todosMatch`: ids win when both sides carry one, otherwise content.
 */
export function todosMatch(todo1, todo2) {
  if (todo1.id && todo2.id) {
    return todo1.id === todo2.id
  }
  return todo1.content === todo2.content
}

/**
 * Validate and normalize one stored todo. Malformed entries are dropped, the
 * same way the V1 task store drops malformed task files.
 */
export function parseTodoInfo(value) {
  if (!isPlainObject(value)) return null
  if (typeof value.content !== "string") return null
  if (!TODO_STATUS_VALUES.includes(value.status)) return null
  if (value.id !== undefined && typeof value.id !== "string") return null
  if (value.priority !== undefined && !TODO_PRIORITY_VALUES.includes(value.priority)) return null
  return {
    ...(value.id !== undefined ? { id: value.id } : {}),
    content: value.content,
    status: value.status,
    ...(value.priority !== undefined ? { priority: value.priority } : {}),
  }
}

/**
 * Tolerantly parse the stored JSON envelope `{ version: 1, todos }`. Any
 * malformed record (wrong version, non-array todos, a raw array from a stale
 * writer) collapses to an empty list rather than throwing.
 */
export function parseTodoEnvelope(value) {
  if (!isPlainObject(value)) return []
  const version = value.version
  if (version !== undefined && version !== TODO_ENVELOPE_VERSION) return []
  if (!Array.isArray(value.todos)) return []
  const todos = []
  for (const entry of value.todos) {
    const parsed = parseTodoInfo(entry)
    if (parsed) todos.push(parsed)
  }
  return todos
}

/**
 * Per-session todo persistence over `ctx.storage`. One key per session; the
 * value is a versioned JSON envelope. Reads never throw on a malformed record.
 */
export function createV2SessionTodoStore({ storage, prefix = "rigel-v2/session-todos" } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("createV2SessionTodoStore requires the V2 storage domain with get/set")
  }

  const keyFor = (sessionID) => `${prefix}/${sessionID}`

  return {
    keyFor,
    async readTodos(sessionID) {
      let value
      try {
        value = await storage.get(keyFor(sessionID))
      } catch {
        return []
      }
      if (value === undefined) return []
      return parseTodoEnvelope(value)
    },
    async writeTodos(sessionID, todos) {
      const list = Array.isArray(todos) ? todos : []
      await storage.set(keyFor(sessionID), { version: TODO_ENVELOPE_VERSION, todos: list })
    },
  }
}

/**
 * V1 `syncTaskTodoUpdate` semantics against the storage-backed store. The
 * caller passes the mapped todo list to `store.writeTodos`; unrelated existing
 * todos are preserved.
 */
export function createTaskTodoSync({ store } = {}) {
  if (!store || typeof store.readTodos !== "function" || typeof store.writeTodos !== "function") {
    throw new TypeError("createTaskTodoSync requires a session todo store")
  }

  return {
    async syncTodos(task, sessionID) {
      const currentTodos = await store.readTodos(sessionID)
      const taskTodo = syncTaskToTodo(task)
      const nextTodos = currentTodos.filter((todo) => {
        if (taskTodo) {
          return !todosMatch(todo, taskTodo)
        }
        // Deleted task: match by id if present, otherwise by content.
        if (todo.id) {
          return todo.id !== task.id
        }
        return todo.content !== task.subject
      })
      if (taskTodo) {
        nextTodos.push(taskTodo)
      }
      await store.writeTodos(sessionID, nextTodos)
      return nextTodos
    },
  }
}
