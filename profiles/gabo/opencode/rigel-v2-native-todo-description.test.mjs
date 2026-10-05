import { describe, expect, test } from "bun:test"

import { TODOWRITE_DESCRIPTION } from "./rigel-v2-flow-logic.mjs"
import {
  TODO_DESCRIPTION_TOOL_NAME,
  createTodoDescriptionTool,
  formatTodoWriteResult,
} from "./rigel-v2-native-todo-description.mjs"

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
