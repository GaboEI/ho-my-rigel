import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  clearTodoPending,
  hasIncompleteTodos,
  readTodoPending,
  resolveBridgeStateRoot,
  todoPendingPath,
  wrapTodoStoreWithPending,
  writeTodoPending,
} from "./rigel-v2-native-todo-pending.mjs"

describe("hasIncompleteTodos", () => {
  test("#given todos #then only pending/in_progress count as incomplete", () => {
    expect(hasIncompleteTodos([])).toBe(false)
    expect(hasIncompleteTodos(undefined)).toBe(false)
    expect(hasIncompleteTodos([{ status: "completed" }, { status: "cancelled" }])).toBe(false)
    expect(hasIncompleteTodos([{ status: "pending" }])).toBe(true)
    expect(hasIncompleteTodos([{ status: "completed" }, { status: "in_progress" }])).toBe(true)
    expect(hasIncompleteTodos([null, "x", { status: "pending" }])).toBe(true)
  })
})

describe("todo pending bridge", () => {
  let stateRoot

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "rigel-todo-bridge-"))
  })

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true })
  })

  test("#given a write with a pending todo #then the record is pending", () => {
    writeTodoPending({ stateRoot, sessionID: "ses_a", todos: [{ status: "pending" }, { status: "completed" }] })
    const record = readTodoPending({ stateRoot, sessionID: "ses_a" })
    expect(record.pending).toBe(true)
    expect(record.incomplete).toBe(1)
    expect(record.total).toBe(2)
    expect(existsSync(todoPendingPath(stateRoot, "ses_a"))).toBe(true)
  })

  test("#given a write with all todos completed #then the record is not pending", () => {
    writeTodoPending({ stateRoot, sessionID: "ses_a", todos: [{ status: "completed" }] })
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" }).pending).toBe(false)
  })

  test("#given no file #then the read is null", () => {
    expect(readTodoPending({ stateRoot, sessionID: "ses_missing" })).toBeNull()
  })

  test("#given a malformed file #then the read is tolerant", () => {
    const file = todoPendingPath(stateRoot, "ses_a")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{not json", "utf-8")
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" })).toBeNull()
  })

  test("#given a different session id inside the file #then the read is rejected", () => {
    const file = todoPendingPath(stateRoot, "ses_a")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ sessionID: "ses_b", pending: true }), "utf-8")
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" })).toBeNull()
  })

  test("#given a write #then the file carries only counts, never todo content", () => {
    writeTodoPending({ stateRoot, sessionID: "ses_a", todos: [{ content: "secret work item", status: "pending" }] })
    const raw = readFileSync(todoPendingPath(stateRoot, "ses_a"), "utf-8")
    expect(raw).not.toContain("secret work item")
  })

  test("#given sessions written independently #then their state is isolated", () => {
    writeTodoPending({ stateRoot, sessionID: "ses_a", todos: [{ status: "pending" }] })
    writeTodoPending({ stateRoot, sessionID: "ses_b", todos: [{ status: "completed" }] })
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" }).pending).toBe(true)
    expect(readTodoPending({ stateRoot, sessionID: "ses_b" }).pending).toBe(false)
  })

  test("#given a session delete #then the bridge file is removed", () => {
    writeTodoPending({ stateRoot, sessionID: "ses_a", todos: [{ status: "pending" }] })
    clearTodoPending({ stateRoot, sessionID: "ses_a" })
    expect(existsSync(todoPendingPath(stateRoot, "ses_a"))).toBe(false)
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" })).toBeNull()
  })

  test("#given the record persists on disk #then a later read still sees it (restart persistence)", () => {
    writeTodoPending({ stateRoot, sessionID: "ses_a", todos: [{ status: "pending" }], now: () => "2026-10-06T00:00:00.000Z" })
    // No in-memory state exists: the record survives because it is on disk.
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" }).updatedAt).toBe("2026-10-06T00:00:00.000Z")
  })

  test("#given XDG_STATE_HOME #then the state root follows it", () => {
    expect(resolveBridgeStateRoot({ XDG_STATE_HOME: "/tmp/xdg-state" })).toBe("/tmp/xdg-state")
    expect(resolveBridgeStateRoot({})).toContain("oh-my-rigel-state")
  })

  test("#given a crafted session id #then the bridge path cannot escape the bridge directory", () => {
    const path = todoPendingPath(stateRoot, "../../etc/passwd")
    expect(path.startsWith(join(stateRoot, "oh-my-rigel/todo-pending"))).toBe(true)
    expect(path).not.toContain("..")
  })
})

describe("wrapTodoStoreWithPending", () => {
  let stateRoot

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "rigel-todo-bridge-"))
  })

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true })
  })

  test("#given a store #then reads are delegated and writes mirror the pending state", async () => {
    const writes = []
    const base = {
      readTodos: async () => [{ status: "pending" }],
      writeTodos: async (sessionID, todos) => { writes.push({ sessionID, todos }); return todos },
    }
    const store = wrapTodoStoreWithPending(base, { stateRoot })
    const result = await store.writeTodos("ses_a", [{ status: "pending" }])
    expect(result).toEqual([{ status: "pending" }])
    expect(writes).toHaveLength(1)
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" }).pending).toBe(true)
    expect(await store.readTodos("ses_a")).toEqual([{ status: "pending" }])
  })

  test("#given a store without writeTodos #then it is returned unchanged", () => {
    const store = { readTodos: async () => [] }
    expect(wrapTodoStoreWithPending(store, { stateRoot })).toBe(store)
  })

  test("#given a failing store write #then the bridge is not written", async () => {
    const base = { readTodos: async () => [], writeTodos: async () => { throw new Error("storage down") } }
    const store = wrapTodoStoreWithPending(base, { stateRoot })
    await expect(store.writeTodos("ses_a", [{ status: "pending" }])).rejects.toThrow("storage down")
    expect(readTodoPending({ stateRoot, sessionID: "ses_a" })).toBeNull()
  })
})
