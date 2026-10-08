import { describe, expect, test } from "bun:test"

import { TODOWRITE_DESCRIPTION } from "./rigel-v2-flow-logic.mjs"
import {
  NATIVE_TOOL_DESCRIPTION_OVERRIDES,
  TODO_DESCRIPTION_TOOL_NAME,
  applyNativeToolDescriptionOverride,
  createTodoDescriptionTool,
  formatTodoWriteResult,
  registerNativeTodoTool,
} from "./rigel-v2-native-todo-description.mjs"

/** Minimal stand-in for the V2 tool editor: records update/remove calls. */
function createFakeEditor(seed = []) {
  const stored = new Map()
  for (const definition of seed) stored.set(definition.name, definition)
  const updates = []
  const removals = []
  return {
    get(name) { return stored.get(name) },
    add(definition) { stored.set(definition.name, definition) },
    update(...args) { updates.push(args) },
    remove(...args) { removals.push(args) },
    list() { return [...stored.values()] },
    updates,
    removals,
  }
}

const HOST_READ_DESCRIPTION_SENTINEL = "HOST_READ_DESCRIPTION_SENTINEL"

describe("#given the todo-description-override tool", () => {
  test("#then the tool name is todowrite and its description IS the V1 text", () => {
    // given / when
    const definition = createTodoDescriptionTool()

    // then
    expect(definition.name).toBe(TODO_DESCRIPTION_TOOL_NAME)
    expect(TODO_DESCRIPTION_TOOL_NAME).toBe("todowrite")
    expect(definition.description).toBe(TODOWRITE_DESCRIPTION)
  })
})

describe("#given a real todo store", () => {
  test("#when execute runs #then the list is persisted for the tool session", async () => {
    // given
    const calls = []
    const store = { writeTodos: async (sessionID, todos) => { calls.push({ sessionID, todos }) } }
    const definition = createTodoDescriptionTool({ store })
    const todos = [
      { content: "src/a.ts: add x - returns y", status: "in_progress", priority: "high" },
      { content: "src/b.ts: add z - returns w", status: "pending" },
    ]

    // when
    const result = await definition.execute({ todos }, { sessionID: "ses_todo" })

    // then
    expect(calls).toEqual([{ sessionID: "ses_todo", todos }])
    expect(result.content).toContain("Todo list updated (2 items)")
    expect(result.content).toContain("src/a.ts")
  })

  test("#when no store is present #then execute still returns a valid result", async () => {
    // given
    const definition = createTodoDescriptionTool()

    // when
    const result = await definition.execute({ todos: [{ content: "a", status: "pending" }] }, { sessionID: "ses_x" })

    // then
    expect(typeof result.content).toBe("string")
    expect(result.content).toContain("1 item")
  })

  test("#then formatTodoWriteResult handles the empty list", () => {
    // given / when / then
    expect(formatTodoWriteResult([])).toBe("Todo list cleared.")
  })
})

describe("#given the native tool-description override seam", () => {
  test("#when registerNativeTodoTool runs #then the editor holds todowrite with the V1 description", () => {
    // given
    const editor = createFakeEditor()

    // when
    const registered = registerNativeTodoTool(editor)

    // then
    expect(Object.keys(NATIVE_TOOL_DESCRIPTION_OVERRIDES)).toEqual(["todowrite"])
    expect(editor.get(TODO_DESCRIPTION_TOOL_NAME)).toBe(registered)
    expect(editor.get("todowrite").description).toBe(TODOWRITE_DESCRIPTION)
  })

  test("#when a host tool is pre-seeded #then the runtime never mutates it", () => {
    // given
    const editor = createFakeEditor([
      { name: "read", description: HOST_READ_DESCRIPTION_SENTINEL, input: {} },
    ])

    // when
    registerNativeTodoTool(editor)

    // then
    expect(editor.get("read").description).toBe(HOST_READ_DESCRIPTION_SENTINEL)
    expect(editor.updates).toEqual([])
    expect(editor.removals).toEqual([])
  })

  test("#when the override is applied to an already-overridden definition #then the description is stable", () => {
    // given
    const once = applyNativeToolDescriptionOverride({ name: "todowrite", description: "PLACEHOLDER" })

    // when
    const twice = applyNativeToolDescriptionOverride(once)

    // then
    expect(once.description).toBe(TODOWRITE_DESCRIPTION)
    expect(twice.description).toBe(TODOWRITE_DESCRIPTION)
    expect(twice.description).toBe(once.description)
  })

  test("#when a definition has no matching override #then it passes through unchanged", () => {
    // given
    const hostDefinition = { name: "read", description: HOST_READ_DESCRIPTION_SENTINEL }

    // when
    const result = applyNativeToolDescriptionOverride(hostDefinition)

    // then
    expect(result).toBe(hostDefinition)
    expect(result.description).toBe(HOST_READ_DESCRIPTION_SENTINEL)
  })
})
