/** Scenario family: delegation. */
/**
 * Owners V1: packages/delegate-core/src/{retry-patterns,retry-guidance}.ts,
 *            packages/omo-opencode/src/tools/delegate-task/{constants,subagent-discovery}.ts
 * Mirrors V2: rigel-v2-delegate-retry-core.mjs, rigel-v2-native-core.mjs
 */

const retryCore = () => import("../../rigel-v2-delegate-retry-core.mjs")
const nativeCore = () => import("../../rigel-v2-native-core.mjs")

const ERROR_CORPUS = [
  { name: "unknown category", text: '[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low' },
  { name: "unknown agent", text: '[ERROR] Unknown agent: "fake-agent". Available agents: explore, oracle' },
  { name: "unknown skills", text: "[ERROR] Skills not found: nope. Available: git-master" },
  { name: "missing route", text: "[ERROR] Invalid arguments: Must provide either category or subagent_type." },
  { name: "missing load_skills", text: "[ERROR] Invalid arguments: load_skills=null is not allowed. Pass [] if no skills needed." },
  { name: "mutual exclusion", text: "[ERROR] Invalid arguments: Provide EITHER category OR subagent_type, not both." },
  { name: "unrelated error negative", text: "[ERROR] provider 500 from upstream" },
  { name: "raw unknown agent negative", text: 'Unknown agent: "x". Available agents: explore' },
  { name: "plain text negative", text: "Found 3 files matching the pattern." },
]

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "delegation.retry-classification",
    family: "delegation",
    oracle: "delegate-core.retry-patterns",
    why: "V2 detects the same recoverable delegate-task errors as V1, including the gate that ignores raw (unframed) resolver text.",
    loadV2: retryCore,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.detectDelegateTaskError(input.text)?.errorType ?? null,
    observeV2: (v2, input) => v2.detectDelegateTaskError(input.text)?.errorType ?? null,
    corpus: ERROR_CORPUS,
    mutation: { target: "detectDelegateTaskError", perturb: () => () => null },
  },
  {
    id: "delegation.retry-guidance",
    family: "delegation",
    oracle: "delegate-core.retry-guidance",
    why: "V2 builds the same corrective retry guidance text as V1 for each detected error type.",
    loadV2: retryCore,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.buildRetryGuidance({ errorType: input.errorType, originalOutput: input.text }),
    observeV2: (v2, input) => v2.buildRetryGuidance({ errorType: input.errorType, originalOutput: input.text }),
    corpus: [
      { name: "unknown_category", errorType: "unknown_category", text: '[ERROR] Unknown category: "c". Available: quick' },
      { name: "unknown_agent", errorType: "unknown_agent", text: '[ERROR] Unknown agent: "a". Available agents: explore' },
      { name: "unknown_skills", errorType: "unknown_skills", text: "[ERROR] Skills not found: s. Available: git-master" },
      { name: "missing_category_or_agent", errorType: "missing_category_or_agent", text: "[ERROR] Invalid arguments: Must provide either category or subagent_type." },
      { name: "mutual_exclusion", errorType: "mutual_exclusion", text: "[ERROR] Invalid arguments: Provide EITHER category OR subagent_type, not both." },
    ],
    mutation: { target: "buildRetryGuidance", perturb: () => () => "drifted guidance" },
  },
  {
    id: "delegation.coordinator-guard",
    family: "delegation",
    oracle: "delegate-task.constants",
    why: "V2 blocks the same coordinator agents as V1 (decision to reject a delegation target).",
    loadV2: nativeCore,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.isCoordinatorAgent(input.agent),
    observeV2: (v2, input) => v2.isCoordinatorAgent(input.agent),
    corpus: [
      { name: "prometheus", agent: "prometheus" },
      { name: "prometheus display", agent: "Prometheus - Plan Builder" },
      { name: "plan", agent: "plan" },
      { name: "explore", agent: "explore" },
      { name: "sisyphus", agent: "sisyphus" },
      { name: "empty", agent: "" },
      { name: "undefined", agent: undefined },
    ],
    mutation: { target: "isCoordinatorAgent", perturb: () => () => false },
  },
  {
    id: "delegation.demoted-plan",
    family: "delegation",
    oracle: "delegate-task.subagent-discovery",
    why: "V2 classifies the demoted plan subagent exactly as V1 (hidden + subagent mode + plan family).",
    loadV2: nativeCore,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.isDemotedPlanAgent(input.agent),
    observeV2: (v2, input) => v2.isDemotedPlanAgent(input.agent),
    corpus: [
      { name: "plan demoted", agent: { name: "plan", hidden: true, mode: "subagent" } },
      { name: "build hidden", agent: { name: "build", hidden: true, mode: "subagent" } },
      { name: "explore visible", agent: { name: "explore", hidden: false, mode: "all" } },
      { name: "prometheus primary", agent: { name: "Prometheus - Plan Builder", hidden: false, mode: "primary" } },
    ],
    mutation: { target: "isDemotedPlanAgent", perturb: () => () => false },
  },
]
