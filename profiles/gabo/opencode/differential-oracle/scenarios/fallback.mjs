/** Scenario family: fallback. */
/**
 * Owners V1: packages/model-core/src/{agent-model-requirements,category-model-requirements,model-string-parser,provider-model-id-transform}.ts
 * Mirror V2: rigel-v2-native-model-chains.mjs, rigel-v2-background-retry.mjs
 *
 * V1 stores a chain under `{ fallbackChain: [...] }`; V2 exports the bare
 * array. The projection compares the real chain data over every V1 agent key,
 * which also fails if V2 drops a key (a reduction).
 */

const chainsV2 = () => import("../../rigel-v2-native-model-chains.mjs")
const retryV2 = () => import("../../rigel-v2-background-retry.mjs")

const agentKeys = (v1) => Object.keys(v1.AGENT_MODEL_REQUIREMENTS).map((name) => ({ name }))
const categoryKeys = (v1) => Object.keys(v1.CATEGORY_MODEL_REQUIREMENTS).map((name) => ({ name }))

/**
 * Canonical model identity from either parser: V1 uses {providerID, modelID,
 * variant}; V2 uses {providerID, id} with the variant folded into the id. Both
 * reconstruct `provider/id[:variant]`; a bare model (no provider) yields null
 * on both sides.
 */
function canonicalModel(parsed, isV2) {
  if (!parsed || typeof parsed !== "object") return null
  if (typeof parsed.providerID !== "string" || parsed.providerID.length === 0) return null
  const id = isV2 ? parsed.id : parsed.modelID
  if (typeof id !== "string" || id.length === 0) return null
  const variant = !isV2 && parsed.variant ? `:${parsed.variant}` : ""
  return `${parsed.providerID}/${id}${variant}`
}

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "fallback.agent-chains",
    family: "fallback",
    oracle: "model-core.agent-requirements",
    why: "V2 carries every V1 per-agent fallback chain, unchanged and complete (no dropped agent, no altered rung).",
    loadV2: chainsV2,
    tolerance: { kind: "artifact-equality" },
    corpus: agentKeys,
    observeV1: (v1, input) => v1.AGENT_MODEL_REQUIREMENTS[input.name]?.fallbackChain ?? null,
    observeV2: (v2, input) => v2.AGENT_MODEL_CHAINS[input.name] ?? null,
    mutation: { target: "AGENT_MODEL_CHAINS", perturb: () => ({}), onDisk: { find: "export const AGENT_MODEL_CHAINS =", replace: "export const AGENT_MODEL_CHAINS = {};\nconst __orig_AGENT_MODEL_CHAINS =" } },
  },
  {
    id: "fallback.category-chains",
    family: "fallback",
    oracle: "model-core.category-requirements",
    why: "V2 carries every V1 per-category fallback chain, unchanged and complete.",
    loadV2: chainsV2,
    tolerance: { kind: "artifact-equality" },
    corpus: categoryKeys,
    observeV1: (v1, input) => v1.CATEGORY_MODEL_REQUIREMENTS[input.name]?.fallbackChain ?? null,
    observeV2: (v2, input) => v2.CATEGORY_MODEL_CHAINS[input.name] ?? null,
    mutation: { target: "CATEGORY_MODEL_CHAINS", perturb: () => ({}), onDisk: { find: "export const CATEGORY_MODEL_CHAINS =", replace: "export const CATEGORY_MODEL_CHAINS = {};\nconst __orig_CATEGORY_MODEL_CHAINS =" } },
  },
  {
    id: "fallback.model-string-parser",
    family: "fallback",
    oracle: "model-core.model-string-parser",
    why: "V2 parses `provider/model[:variant]` strings to the same parts as V1.",
    loadV2: chainsV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => canonicalModel(v1.parseModelString(input.value) ?? null, false),
    observeV2: (v2, input) => canonicalModel(v2.parseModel(input.value) ?? null, true),
    corpus: [
      { name: "plain", value: "anthropic/claude-sonnet-4-5" },
      { name: "variant", value: "openai/gpt-5.2:high" },
      { name: "deepseek", value: "deepseek/deepseek-flash" },
      { name: "bare", value: "bare-model" },
      { name: "empty", value: "" },
    ],
    mutation: { target: "parseModel", perturb: () => () => null },
  },
  {
    id: "fallback.provider-transform",
    family: "fallback",
    oracle: "model-core.provider-transform",
    why: "V2 applies the same provider-specific model id transform as V1.",
    loadV2: retryV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.transformModelForProvider(input.provider, input.model),
    observeV2: (v2, input) => v2.transformModelForProvider(input.provider, input.model),
    corpus: [
      { name: "anthropic", provider: "anthropic", model: "claude-sonnet-4-5" },
      { name: "openai", provider: "openai", model: "gpt-5.2" },
      { name: "google", provider: "google", model: "gemini-3-pro" },
      { name: "unknown provider", provider: "custom", model: "some-model" },
    ],
    mutation: { target: "transformModelForProvider", perturb: () => () => "drifted" },
  },
]
