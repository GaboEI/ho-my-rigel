/**
 * RED parity tests for the V2 native compaction todo-preserver port.
 *
 * The port must reproduce the V1 bootstrap-todo predicates exactly (id OR
 * content match) and the restore-over-current decision, and must expose the
 * capture / restore / beforeTodoWrite surface the V2 event wiring calls. The V2
 * module does not exist yet, so every test here is RED until it lands.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  ATLAS_BOOTSTRAP_TODOS,
  createNativeCompactionTodoPreserver,
  hasDetailedTodos,
  isAtlasBootstrapTodo,
  isAtlasBootstrapTodoList,
  shouldRestoreOverCurrentTodos,
} from "./rigel-v2-native-compaction-todo-preserver.mjs"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const V1_HOOK_SOURCE = join(
  REPO_ROOT,
  "packages",
  "omo-opencode",
  "src",
  "hooks",
  "compaction-todo-preserver",
  "hook.ts",
)

function v1BootstrapTodos() {
  const source = readFileSync(V1_HOOK_SOURCE, "utf8")
  const block = /const ATLAS_BOOTSTRAP_TODOS = \[([\s\S]*?)\] as const/.exec(source)
  if (!block) throw new Error("could not parse the V1 ATLAS_BOOTSTRAP_TODOS declaration")
  const pairPattern = /id:\s*"([^"]+)"[\s\S]*?content:\s*"([^"]+)"/g
  const pairs = [...block[1].matchAll(pairPattern)].map((match) => ({ id: match[1], content: match[2] }))
  if (pairs.length === 0) throw new Error("could not extract the V1 bootstrap todo entries")
  return pairs
}

function todo(content, overrides = {}) {
  return { content, status: "pending", priority: "medium", ...overrides }
}

const BOOTSTRAP = v1BootstrapTodos().map(({ id, content }) => todo(content, { id }))
const DETAILED = todo("Investigate the failing test")

describe("#given the V2 compaction todo-preserver port", () => {
  describe("#when the bootstrap todo table is compared to V1", () => {
    test("#then the same ids and contents are declared", () => {
      // given
      const expected = v1BootstrapTodos()
      // when / then
      expect(ATLAS_BOOTSTRAP_TODOS.map(({ id }) => id)).toEqual(expected.map(({ id }) => id))
      expect(ATLAS_BOOTSTRAP_TODOS.map(({ content }) => content)).toEqual(expected.map(({ content }) => content))
    })
  })

  describe("#given isAtlasBootstrapTodo", () => {
    test("#then an id match or a content match is bootstrap and anything else is not", () => {
      // given
      const first = ATLAS_BOOTSTRAP_TODOS[0]
      // when / then
      expect(isAtlasBootstrapTodo(todo("anything", { id: first.id }))).toBe(true)
      expect(isAtlasBootstrapTodo(todo(first.content, { id: "not-bootstrap" }))).toBe(true)
      expect(isAtlasBootstrapTodo(todo("unrelated work", { id: "not-bootstrap" }))).toBe(false)
    })
  })

  describe("#given hasDetailedTodos", () => {
    test("#then only a list containing a non-bootstrap todo is detailed", () => {
      // given / when / then
      expect(hasDetailedTodos(BOOTSTRAP)).toBe(false)
      expect(hasDetailedTodos([...BOOTSTRAP, DETAILED])).toBe(true)
      expect(hasDetailedTodos([DETAILED])).toBe(true)
      expect(hasDetailedTodos([])).toBe(false)
    })
  })

  describe("#given isAtlasBootstrapTodoList", () => {
    test("#then only a non-empty list made entirely of bootstrap todos is bootstrap", () => {
      // given / when / then
      expect(isAtlasBootstrapTodoList([])).toBe(false)
      expect(isAtlasBootstrapTodoList(BOOTSTRAP)).toBe(true)
      expect(isAtlasBootstrapTodoList([...BOOTSTRAP, DETAILED])).toBe(false)
      expect(isAtlasBootstrapTodoList([DETAILED])).toBe(false)
    })
  })

  describe("#given shouldRestoreOverCurrentTodos", () => {
    test("#then it restores when the current todo list is empty", () => {
      // given / when / then
      expect(shouldRestoreOverCurrentTodos({ snapshot: [DETAILED], currentTodos: [] })).toBe(true)
    })

    test("#then it does not restore over detailed current todos", () => {
      // given / when / then
      expect(shouldRestoreOverCurrentTodos({ snapshot: [DETAILED], currentTodos: [DETAILED] })).toBe(false)
    })

    test("#then over an all-bootstrap current list it restores only when the snapshot has detailed todos", () => {
      // given / when / then
      expect(shouldRestoreOverCurrentTodos({ snapshot: [DETAILED], currentTodos: BOOTSTRAP })).toBe(true)
      expect(shouldRestoreOverCurrentTodos({ snapshot: BOOTSTRAP, currentTodos: BOOTSTRAP })).toBe(false)
    })
  })

  describe("#given createNativeCompactionTodoPreserver", () => {
    test("#then it exposes capture, restore and beforeTodoWrite functions", () => {
      // given / when
      const preserver = createNativeCompactionTodoPreserver()
      // then
      expect(typeof preserver).toBe("object")
      expect(typeof preserver.capture).toBe("function")
      expect(typeof preserver.restore).toBe("function")
      expect(typeof preserver.beforeTodoWrite).toBe("function")
    })
  })
})
