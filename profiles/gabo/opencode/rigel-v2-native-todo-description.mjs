/**
 * Real `todo-description-override` surface for the native OpenCode V2 runtime.
 *
 * V1 (`packages/omo-opencode/src/hooks/todo-description-override/hook.ts`)
 * rewrites the `todowrite` tool description through the V1-only `tool.definition`
 * hook:
 *
 *   "tool.definition": async (input, output) => {
 *     if (input.toolID === "todowrite") output.description = TODOWRITE_DESCRIPTION
 *   }
 *
 * V2.0.22 exposes no `tool.definition` hook and publishes no builtin `todowrite`
 * tool, so the override is delivered the V2 way: the runtime registers a real,
 * working `todowrite` tool whose description IS the exact V1
 * `TODOWRITE_DESCRIPTION`. The tool definition is what the host turns into the
 * model's tool schema, so the model receives the V1 description, and the tool is
 * backed by the runtime's own per-session todo store rather than being a
 * schema-only stub.
 *
 * The earlier "tool.transform is add-only" claim was wrong: the editor exposes
 * `add`/`get`/`update`/`list`/`namespace`/`remove`. `todowrite` is not a
 * V2-owned builtin, so an `editor.add` of that name is model-visible.
 */

import { TODOWRITE_DESCRIPTION } from "./rigel-v2-flow-logic.mjs"
import { normalizeToolDefinition } from "./rigel-v2-native-core.mjs"

/** The V1 tool name this surface overrides. */
export const TODO_DESCRIPTION_TOOL_NAME = "todowrite"

/**
 * The description overrides this runtime applies, keyed by tool name. This is
 * the explicit seam that replaces V1's `tool.definition` hook: the V1 hook
 * mutated whatever definition the host routed through it, while the V2 runtime
 * only ever rewrites the definitions it builds itself.
 */
export const NATIVE_TOOL_DESCRIPTION_OVERRIDES = Object.freeze({ todowrite: TODOWRITE_DESCRIPTION })

/**
 * Apply the native description override to a tool definition, returning the
 * definition unchanged when no override matches. The lookup is keyed by
 * `definition.name`, so a definition the runtime did not build (for example a
 * host-owned `read`) is never touched.
 */
export function applyNativeToolDescriptionOverride(definition) {
  if (!definition || typeof definition.name !== "string") return definition
  const override = NATIVE_TOOL_DESCRIPTION_OVERRIDES[definition.name]
  return override === undefined ? definition : { ...definition, description: override }
}

const TODO_STATUS_VALUES = ["pending", "in_progress", "completed", "cancelled"]
const TODO_PRIORITY_VALUES = ["low", "medium", "high"]

export function formatTodoWriteResult(todos) {
  const list = Array.isArray(todos) ? todos : []
  if (list.length === 0) {
    return "Todo list cleared."
  }
  const lines = list.map((todo, index) => {
    const status = typeof todo?.status === "string" ? todo.status : "pending"
    const priority = typeof todo?.priority === "string" ? ` [${todo.priority}]` : ""
    const content = typeof todo?.content === "string" ? todo.content : ""
    return `${index + 1}. [${status}]${priority} ${content}`
  })
  return `Todo list updated (${list.length} item${list.length === 1 ? "" : "s"}):\n${lines.join("\n")}`
}

/**
 * Build the `todowrite` tool definition. `store` is the runtime's per-session
 * todo store (`createV2SessionTodoStore`); when present the tool persists the
 * list for `toolContext.sessionID`, so the tool is real, not a schema-only stub.
 *
 * `beforeWrite(sessionID, todos)` is the V1 `compaction-todo-preserver`
 * `beforeTodoWrite` seam. When supplied it resolves the list that is actually
 * written and reported: a late all-Atlas-bootstrap `todowrite` after a restore
 * is replaced by the protected detailed snapshot instead of erasing real work.
 */
export function createTodoDescriptionTool({ store, beforeWrite } = {}) {
  // The description is supplied by the override seam, not hardcoded here, so
  // removing the override removes the V1 text and the contract test fails.
  const definition = applyNativeToolDescriptionOverride({
    name: TODO_DESCRIPTION_TOOL_NAME,
    options: { codemode: false },
    input: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full todo list for this session; replaces the stored list.",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Atomic todo title: [WHERE] [HOW] to [WHY] - expect [RESULT].",
              },
              status: { type: "string", enum: TODO_STATUS_VALUES, description: "Todo status." },
              priority: { type: "string", enum: TODO_PRIORITY_VALUES, description: "Optional priority." },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    execute: async (input, toolContext) => {
      const incoming = Array.isArray(input?.todos) ? input.todos : []
      const sessionID = toolContext?.sessionID
      let todos = incoming
      if (typeof beforeWrite === "function" && typeof sessionID === "string" && sessionID) {
        const resolved = beforeWrite(sessionID, incoming)
        if (Array.isArray(resolved)) todos = resolved
      }
      if (store && typeof store.writeTodos === "function" && typeof sessionID === "string" && sessionID) {
        await store.writeTodos(sessionID, todos)
      }
      return { content: formatTodoWriteResult(todos) }
    },
  })
  return normalizeToolDefinition(definition)
}

/**
 * Register the runtime-owned `todowrite` definition on the V2 tool editor. The
 * runtime only ADDS its own definition; it never calls `editor.update` or
 * `editor.remove`, so a host tool (for example `read`) is never mutated.
 */
export function registerNativeTodoTool(editor, { store, beforeWrite } = {}) {
  const definition = applyNativeToolDescriptionOverride(createTodoDescriptionTool({ store, beforeWrite }))
  editor.add(definition)
  return definition
}

