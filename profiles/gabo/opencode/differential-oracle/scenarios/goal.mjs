/** Scenario family: goal. */
/**
 * Owners V1: packages/omo-opencode/src/hooks/goal/{validation,command-arguments,prompt,types}.ts
 * Mirror V2: tools/goal.tools.mjs
 */

const goalV2 = () => import("../../tools/goal.tools.mjs")

function validate(v, objective) {
  try {
    return { ok: true, value: v.validateObjective(objective), message: null }
  } catch (error) {
    return { ok: false, value: null, message: error instanceof Error ? error.message : String(error) }
  }
}

const GOAL = { objective: "Ship the differential oracle", status: "active" }

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "goal.validation",
    family: "goal",
    oracle: "goal.validation",
    why: "V2 validates goal objectives with the same accept/reject decision and message as V1.",
    loadV2: goalV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => validate(v1, input.objective),
    observeV2: (v2, input) => validate(v2, input.objective),
    corpus: [
      { name: "valid", objective: "Ship the oracle" },
      { name: "trim", objective: "  padded objective  " },
      { name: "empty negative", objective: "" },
      { name: "blank negative", objective: "   " },
    ],
    mutation: { target: "validateObjective", perturb: () => () => "always valid" },
  },
  {
    id: "goal.command-parse",
    family: "goal",
    oracle: "goal.command-arguments",
    why: "V2 parses the /goal command arguments to the same action as V1.",
    loadV2: goalV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.parseGoalCommand(input.raw),
    observeV2: (v2, input) => v2.parseGoalCommand(input.raw),
    corpus: [
      { name: "empty show", raw: "" },
      { name: "start", raw: "start ship it" },
      { name: "status", raw: "status" },
      { name: "pause", raw: "pause" },
      { name: "resume", raw: "resume" },
      { name: "stop", raw: "stop" },
    ],
    mutation: { target: "parseGoalCommand", perturb: () => () => ({ kind: "show" }) },
  },
  {
    id: "goal.status-values",
    family: "goal",
    oracle: "goal.types",
    why: "V2 exposes the identical goal status vocabulary as V1.",
    loadV2: goalV2,
    tolerance: { kind: "artifact-equality" },
    corpus: [{ name: "values" }],
    observeV1: (v1) => [...v1.GOAL_STATUS_VALUES],
    observeV2: (v2) => [...v2.GOAL_STATUS_VALUES],
    mutation: { target: "GOAL_STATUS_VALUES", perturb: () => ["drifted"], onDisk: { find: "export const GOAL_STATUS_VALUES =", replace: "export const GOAL_STATUS_VALUES = [];\nconst __orig_GOAL_STATUS_VALUES =" } },
  },
  {
    id: "goal.prompts",
    family: "goal",
    oracle: "goal.prompt",
    why: "V2 builds the same continuation and resume prompts as V1 for the same goal.",
    loadV2: goalV2,
    tolerance: { kind: "exact" },
    observeV1: (v1) => ({ continuation: v1.buildContinuationPrompt(GOAL), resume: v1.buildResumePrompt(GOAL) }),
    observeV2: (v2) => ({ continuation: v2.buildContinuationPrompt(GOAL), resume: v2.buildResumePrompt(GOAL) }),
    corpus: [{ name: "active goal" }],
    mutation: { target: "buildContinuationPrompt", perturb: (real) => (goal) => `${real(goal)} drifted` },
  },
]
