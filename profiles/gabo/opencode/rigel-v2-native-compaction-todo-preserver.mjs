/**
 * Rigel native V2 compaction todo-preserver.
 *
 * Pure port of the V1 `compaction-todo-preserver` behavioral contract from
 * `packages/omo-opencode/src/hooks/compaction-todo-preserver/hook.ts`, retargeted
 * at the V2 storage-backed session todo registry (`createV2SessionTodoStore`)
 * instead of V1's `ctx.client.session.todo` + `opencode/session/todo` writer.
 *
 * V1 kept todos alive across compaction with three moves:
 *   1. `session.compacted` -> `restore()` writes the pre-compaction snapshot
 *      back only when the post-compaction list came back empty or held nothing
 *      but the two Atlas bootstrap entries.
 *   2. Once a detailed snapshot is restored it becomes "protected": a late
 *      `todowrite` that would overwrite it with only Atlas bootstrap entries is
 *      replaced by the snapshot.
 *   3. `session.idle` / `session.deleted` drop both maps.
 *
 * This module carries the predicates byte-for-byte (id OR content match) and the
 * restore decision, plus the capture / restore / beforeTodoWrite surface the V2
 * event wiring calls. It has no I/O and imports nothing from `packages/`; the
 * session store is injected, so the module stays testable and harness-neutral.
 */

/**
 * Same table as the V1 `ATLAS_BOOTSTRAP_TODOS` declaration. Kept in sync by the
 * co-located parity test, which parses the V1 `.ts` source and compares ids and
 * contents.
 */
export const ATLAS_BOOTSTRAP_TODOS = [
  {
    id: "orchestrate-plan",
    content: "Complete ALL implementation tasks",
  },
  {
    id: "pass-final-wave",
    content: "Pass Final Verification Wave - ALL reviewers APPROVE",
  },
]

/**
 * V1 parity: a todo is Atlas bootstrap when its `id` matches a bootstrap id OR
 * its `content` matches a bootstrap content. Anything else is detailed work.
 */
export function isAtlasBootstrapTodo(todo) {
  if (!todo || typeof todo !== "object") {
    return false
  }
  return ATLAS_BOOTSTRAP_TODOS.some(
    (bootstrapTodo) => todo.id === bootstrapTodo.id || todo.content === bootstrapTodo.content,
  )
}

/** V1 parity: a list holds detailed todos when at least one entry is not bootstrap. */
export function hasDetailedTodos(todos) {
  if (!Array.isArray(todos)) {
    return false
  }
  return todos.some((todo) => !isAtlasBootstrapTodo(todo))
}

/** V1 parity: a non-empty list made entirely of bootstrap todos is bootstrap. */
export function isAtlasBootstrapTodoList(todos) {
  if (!Array.isArray(todos)) {
    return false
  }
  return todos.length > 0 && todos.every(isAtlasBootstrapTodo)
}

/**
 * V1 parity decision, used post-compaction:
 *   - an empty current list is always replaced by the snapshot;
 *   - a current list that already holds detailed todos is never overwritten;
 *   - an all-bootstrap current list is replaced only when the snapshot itself
 *     holds detailed todos.
 */
export function shouldRestoreOverCurrentTodos({ snapshot, currentTodos } = {}) {
  const current = Array.isArray(currentTodos) ? currentTodos : []
  const saved = Array.isArray(snapshot) ? snapshot : []
  if (current.length === 0) {
    return true
  }
  if (!isAtlasBootstrapTodoList(current)) {
    return false
  }
  return hasDetailedTodos(saved)
}

/**
 * Build the V2 compaction todo-preserver over an injected session todo store.
 *
 * @param {object} [options]
 * @param {{ readTodos: (sessionID: string) => Promise<Array>, writeTodos: (sessionID: string, todos: Array) => Promise<void> }} [options.store]
 *   The `createV2SessionTodoStore` registry. Optional so the predicates and the
 *   surface can be constructed without a live session.
 */
export function createNativeCompactionTodoPreserver({ store = null } = {}) {
  const snapshots = new Map()
  const protectedSnapshots = new Map()

  const canRead = Boolean(store) && typeof store.readTodos === "function"
  const canWrite = Boolean(store) && typeof store.writeTodos === "function"

  async function readCurrentTodos(sessionID) {
    if (!canRead) {
      throw new TypeError("compaction-todo-preserver requires store.readTodos")
    }
    const todos = await store.readTodos(sessionID)
    return Array.isArray(todos) ? todos : []
  }

  /**
   * Snapshot the session's detailed todos before compaction. A capture only
   * sticks when the list holds at least one detailed todo; an empty or
   * all-bootstrap list clears any previous snapshot (V1 parity). Any previous
   * protected snapshot is dropped, because a fresh capture supersedes it.
   */
  async function capture(sessionID) {
    if (!sessionID) {
      return
    }
    protectedSnapshots.delete(sessionID)
    let todos = []
    try {
      todos = await readCurrentTodos(sessionID)
    } catch {
      snapshots.delete(sessionID)
      return
    }
    if (todos.length === 0 || !hasDetailedTodos(todos)) {
      snapshots.delete(sessionID)
      return
    }
    snapshots.set(sessionID, todos)
  }

  /**
   * Restore the snapshot after compaction when the current list is empty or
   * nothing but Atlas bootstrap entries. When the current list already holds
   * detailed todos the snapshot is dropped and the current list is protected
   * instead, so a later late-bootstrap overwrite cannot erase real work.
   */
  async function restore(sessionID) {
    if (!sessionID) {
      return
    }
    const snapshot = snapshots.get(sessionID)
    if (!snapshot || snapshot.length === 0) {
      return
    }

    let hasCurrent = false
    let currentTodos = []
    try {
      currentTodos = await readCurrentTodos(sessionID)
      hasCurrent = true
    } catch {
      // The store read failed: fall through and let the writer attempt a restore.
    }

    if (hasCurrent && !shouldRestoreOverCurrentTodos({ snapshot, currentTodos })) {
      snapshots.delete(sessionID)
      if (hasDetailedTodos(currentTodos)) {
        protectedSnapshots.set(sessionID, currentTodos)
      } else {
        protectedSnapshots.delete(sessionID)
      }
      return
    }

    protectedSnapshots.set(sessionID, snapshot)

    if (!canWrite) {
      snapshots.delete(sessionID)
      return
    }

    try {
      await store.writeTodos(sessionID, snapshot)
    } finally {
      snapshots.delete(sessionID)
    }
  }

  /**
   * Guard a `todowrite` against late Atlas bootstrap regressions. When a
   * protected detailed snapshot exists and the incoming list is all-bootstrap,
   * return the snapshot so the caller writes it instead. Otherwise clear the
   * protection when real todos are coming through, and return the incoming list
   * unchanged.
   */
  function beforeTodoWrite(sessionID, todos) {
    const incoming = Array.isArray(todos) ? todos : []
    const snapshot = protectedSnapshots.get(sessionID)
    if (!snapshot || !hasDetailedTodos(snapshot)) {
      return incoming
    }
    if (incoming.length === 0) {
      return incoming
    }
    if (!isAtlasBootstrapTodoList(incoming)) {
      protectedSnapshots.delete(sessionID)
      return incoming
    }
    return snapshot
  }

  /** Drop all state for a session (V1 `session.idle` / `session.deleted`). */
  function forget(sessionID) {
    if (!sessionID) {
      return
    }
    snapshots.delete(sessionID)
    protectedSnapshots.delete(sessionID)
  }

  return { capture, restore, beforeTodoWrite, forget }
}
