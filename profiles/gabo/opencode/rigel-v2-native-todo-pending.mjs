/**
 * Per-session pending-todos bridge for the native OpenCode V2 runtime.
 *
 * OpenCode V2 removed the server session-todo API (`session.todo`), so the
 * runtime owns a per-session todo registry in the server plugin's storage
 * (`tools/session-todo-store.mjs`). That store is server-process memory and is
 * NOT reachable from the companion CLI plugin, which runs in the TUI process:
 * they are separate processes with separate storage scopes.
 *
 * The V1 `session-notification` gate `skipIfIncompleteTodos` needs the CLI to
 * know whether the session still has work, so this module is the shared,
 * location-independent bridge: the server-side owner of the todo store mirrors
 * each write to one small per-session file under the shared XDG state root, and
 * the CLI companion reads it. It is the V2-native equivalent of V1's
 * `<project>/.omo/run-continuation/<sessionID>.json` `todo` source, written by
 * the same owner that holds the todos.
 *
 * The record carries only counts and a boolean, never todo content, so the CLI
 * learns "is there pending work" without reading the session's text. The file
 * survives a restart, is per session, and is removed when the session is
 * deleted. Reads are tolerant; a malformed or absent file degrades to "no known
 * pending work" rather than throwing inside a hook.
 *
 * Pure persistence: no imports beyond `node:fs` / `node:path` / `node:os`.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

/** Directory (relative to the state root) that holds the per-session files. */
export const TODO_PENDING_DIR = "oh-my-rigel/todo-pending"

/** V1 `hasIncompleteTodos`: a todo is pending unless completed or cancelled. */
export function hasIncompleteTodos(todos) {
  if (!Array.isArray(todos)) return false
  return todos.some((todo) => {
    if (!todo || typeof todo !== "object") return false
    const status = todo.status
    return status !== "completed" && status !== "cancelled"
  })
}

/**
 * The shared state root both processes resolve. `XDG_STATE_HOME` is set in the
 * isolated laboratory for the server and for the TUI client alike; an unset
 * value falls back to the OS temp dir in both, so they still agree.
 */
export function resolveBridgeStateRoot(env = process.env) {
  const configured = env?.XDG_STATE_HOME
  if (typeof configured === "string" && configured.trim().length > 0) return configured
  return join(tmpdir(), "oh-my-rigel-state")
}

/**
 * Per-session bridge path. The session id is hashed into the filename, so a
 * crafted id containing separators or `..` cannot escape the bridge directory;
 * the record still carries the raw id so a mismatched file is rejected on read.
 */
export function todoPendingPath(stateRoot, sessionID) {
  const name = createHash("sha1").update(String(sessionID)).digest("hex")
  const directory = resolve(stateRoot, TODO_PENDING_DIR)
  const file = resolve(directory, `${name}.json`)
  const contained = relative(directory, file)
  if (contained.length === 0 || contained.startsWith(`..${sep}`) || contained === "..") {
    // Defensive: a hash can never escape, but assert the invariant anyway.
    return join(directory, "invalid-session.json")
  }
  return file
}

function isSessionID(value) {
  return typeof value === "string" && value.length > 0
}

/**
 * Mirror the session's todo state. Best-effort: a filesystem failure never
 * breaks the runtime that called the store.
 */
export function writeTodoPending({ stateRoot, sessionID, todos, now } = {}) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || !isSessionID(sessionID)) return
  const list = Array.isArray(todos) ? todos : []
  const timestamp = typeof now === "function" ? now() : new Date().toISOString()
  const record = {
    sessionID,
    pending: hasIncompleteTodos(list),
    incomplete: list.filter((todo) => todo && typeof todo === "object" && todo.status !== "completed" && todo.status !== "cancelled").length,
    total: list.length,
    updatedAt: timestamp,
  }
  const file = todoPendingPath(stateRoot, sessionID)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, "utf-8")
    renameSync(temporary, file)
  } catch (error) {
    if (error instanceof Error) return
    return
  }
}

/** Tolerant read; returns null when absent, malformed, or the wrong session. */
export function readTodoPending({ stateRoot, sessionID } = {}) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || !isSessionID(sessionID)) return null
  const file = todoPendingPath(stateRoot, sessionID)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (parsed.sessionID !== sessionID) return null
    return {
      sessionID,
      pending: parsed.pending === true,
      incomplete: typeof parsed.incomplete === "number" ? parsed.incomplete : 0,
      total: typeof parsed.total === "number" ? parsed.total : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    }
  } catch (error) {
    if (error instanceof Error) return null
    return null
  }
}

/** Remove the bridge file for a deleted session. Best-effort. */
export function clearTodoPending({ stateRoot, sessionID } = {}) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || !isSessionID(sessionID)) return
  const file = todoPendingPath(stateRoot, sessionID)
  if (!existsSync(file)) return
  try {
    rmSync(file)
  } catch (error) {
    if (error instanceof Error) return
    return
  }
}

/**
 * Wrap the runtime's todo store so every write also mirrors the pending state
 * for the CLI companion. Reads and key resolution are delegated unchanged, so
 * the runtime observes identical behavior; only a side-channel file is added.
 */
export function wrapTodoStoreWithPending(store, { stateRoot, now } = {}) {
  if (!store || typeof store.writeTodos !== "function") return store
  return {
    keyFor: typeof store.keyFor === "function" ? store.keyFor : undefined,
    readTodos: (sessionID) => store.readTodos(sessionID),
    async writeTodos(sessionID, todos) {
      const result = await store.writeTodos(sessionID, todos)
      writeTodoPending({ stateRoot, sessionID, todos, now })
      return result
    },
  }
}
