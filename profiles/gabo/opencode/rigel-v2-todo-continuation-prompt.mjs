/**
 * V2 port of the V1 todo-continuation prompt.
 *
 * The V1 runtime filters internal messages on the system-directive sentinel
 * (`[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]`), so the marker and
 * the full prompt must stay byte-for-byte identical to
 * `packages/omo-opencode/src/hooks/todo-continuation-enforcer/constants.ts`.
 * A drift here means the injected continuation would stop being recognized.
 */

export const CONTINUATION_PROMPT_MARKER = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]"

export const CONTINUATION_PROMPT = `${CONTINUATION_PROMPT_MARKER}

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe all work is already complete, the system is questioning your completion claim. Critically re-examine each todo item from a skeptical perspective, verify the work was actually done correctly, and update the todo list accordingly.`

export function buildContinuationPrompt({ todos, incompleteCount }) {
  const incompleteTodos = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
  const todoList = incompleteTodos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")
  return `${CONTINUATION_PROMPT}\n\n[Status: ${todos.length - incompleteCount}/${todos.length} completed, ${incompleteCount} remaining]\n\nRemaining tasks:\n${todoList}`
}
