/** Scenario family: permissions. */
/**
 * Owner V1: packages/omo-opencode/src/agents/frontier-tool-schema-guard.ts
 * Mirror V2: rigel-v2-native-permissions.mjs
 *
 * The general permission decision model is additionally proven live against
 * the isolated lab (a forbidden tool call must be blocked by V2 permissions,
 * not by a prompt); the frontier schema deny-map is proven here hermetically
 * against the real V1 owner.
 */

const permissionsV2 = () => import("../../rigel-v2-native-permissions.mjs")

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "permissions.frontier-guard",
    family: "permissions",
    oracle: "agents.frontier-guard",
    why: "V2 denies the same tool-schema actions as the V1 frontier guard for the same frontier models. V1 takes a model id string; the runtime hands V2 a model reference ({providerID,id}), so each side is called as production calls it.",
    loadV2: permissionsV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.getFrontierToolSchemaPermission(input.modelId),
    observeV2: (v2, input) => v2.frontierToolSchemaPermission({ providerID: input.providerID, id: input.modelId }),
    corpus: [
      { name: "opus 4.7", providerID: "anthropic", modelId: "claude-opus-4-7" },
      { name: "opus 4.6", providerID: "anthropic", modelId: "claude-opus-4-6" },
      { name: "gpt 5.5", providerID: "openai", modelId: "gpt-5.5" },
      { name: "gpt 5.6", providerID: "openai", modelId: "gpt-5.6" },
      { name: "gpt 6", providerID: "openai", modelId: "gpt-6" },
      { name: "sonnet non-frontier", providerID: "anthropic", modelId: "claude-sonnet-4-6" },
      { name: "gpt-4o non-frontier", providerID: "openai", modelId: "gpt-4o" },
    ],
    mutation: { target: "frontierToolSchemaPermission", perturb: () => () => ({}) },
  },
]
