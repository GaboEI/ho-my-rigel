/**
 * Thin `tool.execute.before` binders for Oh My Rigel's native OpenCode V2
 * runtime.
 *
 * The deterministic decisions live in `rigel-v2-flow-logic.mjs` (T9); this
 * module only adapts a V2 tool event to those pure functions and writes the
 * result back in place. Every rule is a `{ name, run }` object accepted by
 * `runOrderedRules` (T6/T11), so a rule that throws is isolated and the rest of
 * the chain still runs.
 *
 * Three V1 hooks are bound here:
 *   - notepad-write-guard     : block `write` into a notepad root (throws).
 *   - question-label-truncator : truncate over-long question option labels.
 *   - sisyphus-junior-notepad  : prepend the notepad directive to a delegation
 *                                prompt issued by the orchestrator.
 *
 * Event shape is the V2 `tool.execute.before` contract probed by T1: the tool
 * name is `event.tool`, the caller agent is `event.agent`, and the call
 * arguments live in `event.input` (NOT `event.args`). T1 proved mutating
 * `event.input` in a before hook propagates to the executing tool, so the two
 * mutating binders rewrite the existing object in place instead of replacing
 * it.
 *
 * `RIGEL_NATIVE_TASK_NAME` (the runtime's own env override, native.mjs) renames
 * the delegation tool. The default is `rigel_task`, the V2 name for V1's
 * `task`; the delegation rule matches whichever name the runtime registered.
 */

import {
  decideJuniorNotepadInjection,
  decideNotepadWriteBlock,
  decideQuestionLabelTruncation,
} from "./rigel-v2-flow-logic.mjs"
import { canonicalAgentKey } from "./rigel-v2-native-category-skill-reminder.mjs"

export const NOTEPAD_WRITE_GUARD_NAME = "notepad-write-guard"
export const QUESTION_LABEL_TRUNCATOR_NAME = "question-label-truncator"
export const SISYPHUS_JUNIOR_NOTEPAD_NAME = "sisyphus-junior-notepad"

/** The only orchestrator caller V1 injects the junior notepad directive for. */
export const ORCHESTRATOR_AGENT = "atlas"

/** V2 delegation tool name when `RIGEL_NATIVE_TASK_NAME` is unset. */
export const DEFAULT_DELEGATION_TOOL_NAME = "rigel_task"

/**
 * Resolve the runtime's delegation tool name the same way native.mjs does:
 * `RIGEL_NATIVE_TASK_NAME` when set to a non-empty string, otherwise
 * `rigel_task`. `env` is injectable for tests.
 */
export function resolveDelegationToolName(env = process.env) {
  const override = env?.RIGEL_NATIVE_TASK_NAME
  return typeof override === "string" && override.length > 0 ? override : DEFAULT_DELEGATION_TOOL_NAME
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The arguments object for a V2 tool event. `event.input` is the canonical
 * field (T1); `event.args` is accepted as a compatibility fallback so the same
 * binders work against the older prometheus-shaped event used elsewhere in the
 * runtime.
 */
function readInput(event) {
  if (!isPlainObject(event)) return undefined
  if (isPlainObject(event.input)) return event.input
  if (isPlainObject(event.args)) return event.args
  return undefined
}

/**
 * Block `write` into a notepad root by throwing the exact V1 message. The
 * throw is intentional: `runOrderedRules` records it as an isolated failure and
 * keeps running the remaining rules.
 */
export const notepadWriteGuard = {
  name: NOTEPAD_WRITE_GUARD_NAME,
  run(event) {
    const tool = isPlainObject(event) ? event.tool : undefined
    const blockMessage = decideNotepadWriteBlock(tool, readInput(event))
    if (blockMessage === null) return
    throw new Error(blockMessage)
  },
}

/**
 * Truncate over-long question option labels in place. The pure decision returns
 * a rebuilt args object; V2 ignores a returned value, so the questions array is
 * assigned back onto the same `event.input` object the runtime will execute.
 */
export const questionLabelTruncator = {
  name: QUESTION_LABEL_TRUNCATOR_NAME,
  run(event) {
    const tool = isPlainObject(event) ? event.tool : undefined
    const input = readInput(event)
    const truncated = decideQuestionLabelTruncation(tool, input)
    if (truncated === null || truncated === input || !isPlainObject(input)) return
    input.questions = truncated.questions
  },
}

/**
 * Build the sisyphus-junior-notepad rule for a given delegation tool name. The
 * name defaults to the runtime's own resolution so production and the runtime
 * always agree; tests inject a name directly.
 *
 * The pure decision is keyed on V1's `task` name, so the binder verifies the V2
 * delegation name first and then hands the decision the V1 key. The caller's
 * `event.agent` is canonicalized the way the runtime names agents, so a display
 * name such as `Atlas - Plan Executor` resolves to `atlas`.
 */
export function createSisyphusJuniorNotepadRule({ taskToolName } = {}) {
  const delegationToolName = typeof taskToolName === "string" && taskToolName.length > 0
    ? taskToolName
    : resolveDelegationToolName()
  return {
    name: SISYPHUS_JUNIOR_NOTEPAD_NAME,
    run(event) {
      if (!isPlainObject(event) || event.tool !== delegationToolName) return
      const input = readInput(event)
      if (!input) return
      const directive = decideJuniorNotepadInjection({
        tool: "task",
        isOrchestrator: canonicalAgentKey(event.agent) === ORCHESTRATOR_AGENT,
        prompt: input.prompt,
      })
      if (directive === null) return
      input.prompt = directive
    },
  }
}

/** The default junior-notepad rule, wired to the runtime's delegation name. */
export const sisyphusJuniorNotepad = createSisyphusJuniorNotepadRule()

/**
 * The ordered `tool.execute.before` rules this module contributes. The runtime
 * appends them after the built-in write guards. Each `run` is a no-op when its
 * guard does not apply, so the array is safe to run empty, partially, or with
 * every rule present.
 */
export const beforeRules = Object.freeze([
  notepadWriteGuard,
  questionLabelTruncator,
  sisyphusJuniorNotepad,
])
