/** Scenario family: recovery. */
/**
 * Owners V1: packages/omo-opencode/src/hooks/{edit-error-recovery,json-error-recovery,plan-format-validator}/
 * Mirror V2: rigel-v2-native-recovery.mjs, rigel-v2-native-plan-format-validator.mjs
 *
 * V2 recovery intentionally ships a SUPERSET of V1 patterns (extra V2 edit
 * phrasings and extra excluded tools). The parity corpus uses only the shared
 * V1-triggering inputs; a separate assertion (in the test) checks the V2 set is
 * not a reduction of V1.
 */

const recoveryV2 = () => import("../../rigel-v2-native-recovery.mjs")
const planV2 = () => import("../../rigel-v2-native-plan-format-validator.mjs")

function v1RecoveryObserved(v1, input, factoryName) {
  const hook = v1[factoryName]({})
  const out = { output: input.text }
  hook["tool.execute.after"]({ tool: input.tool, sessionID: "s", callID: "c" }, out)
  if (out.output.length <= input.text.length) return { appended: false, text: null }
  return { appended: true, text: out.output.slice(input.text.length).replace(/^\n+/, "") }
}

function v2RecoveryObserved(v2, input) {
  const event = { tool: input.tool, result: { content: input.text } }
  const appended = v2.applyNativeRecoveryReminder(event)
  if (!appended) return { appended: false, text: null }
  return { appended: true, text: event.result.content.slice(input.text.length).replace(/^\n+/, "") }
}

const EDIT_CORPUS = [
  { name: "oldString not found", tool: "edit", text: "error: oldString not found in file" },
  { name: "must be different", tool: "edit", text: "oldString and newString must be different" },
  { name: "found multiple times", tool: "edit", text: "oldString found multiple times" },
  { name: "non-edit tool negative", tool: "write", text: "oldString not found" },
  { name: "plain success negative", tool: "edit", text: "file edited successfully" },
]

const JSON_CORPUS = [
  { name: "invalid json", tool: "edit", text: "Invalid JSON in tool arguments near line 3" },
  { name: "json parse error", tool: "write", text: "json parse error: unexpected end of input" },
  { name: "excluded tool negative", tool: "read", text: "invalid json" },
  { name: "plain negative", tool: "edit", text: "all good" },
]

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "recovery.edit",
    family: "recovery",
    oracle: "recovery.edit",
    why: "V2 appends the same edit-error recovery reminder, on the same edit-tool failures, as the V1 hook.",
    loadV2: recoveryV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1RecoveryObserved(v1, input, "createEditErrorRecoveryHook"),
    observeV2: (v2, input) => v2RecoveryObserved(v2, input),
    corpus: EDIT_CORPUS,
    mutation: { target: "applyNativeRecoveryReminder", perturb: () => () => false },
  },
  {
    id: "recovery.json",
    family: "recovery",
    oracle: "recovery.json",
    why: "V2 appends the same JSON recovery reminder, respecting the same excluded-tool set, as the V1 hook.",
    loadV2: recoveryV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1RecoveryObserved(v1, input, "createJsonErrorRecoveryHook"),
    observeV2: (v2, input) => v2RecoveryObserved(v2, input),
    corpus: JSON_CORPUS,
    mutation: { target: "applyNativeRecoveryReminder", perturb: () => () => false },
  },
  {
    id: "recovery.plan-effort",
    family: "recovery",
    oracle: "plan-format.effort",
    why: "V2 normalizes plan effort bands exactly as the V1 plan-format validator.",
    loadV2: planV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => ({
      band: v1.effortBandForDuration(input.value),
      normalized: v1.normalizePlanEffort(`**Effort:** ${input.value}\n`),
    }),
    observeV2: (v2, input) => ({
      band: v2.effortBandForDuration(input.value),
      normalized: v2.normalizePlanEffort(`**Effort:** ${input.value}\n`),
    }),
    corpus: [
      { name: "hours", value: "2h" },
      { name: "days", value: "3 days" },
      { name: "weeks", value: "3 weeks" },
      { name: "minutes", value: "45 minutes" },
      { name: "invalid", value: "sometime" },
    ],
    mutation: { target: "effortBandForDuration", perturb: () => () => null },
  },
]
