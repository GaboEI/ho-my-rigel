/** Scenario family: compaction. */
/**
 * Owner V1: packages/omo-opencode/src/hooks/compaction-context-injector/compaction-context-prompt.ts
 * Mirror V2: rigel-v2-native-compaction-context.mjs
 *
 * The compaction context template is a data artifact both sides inject into the
 * summary request. Byte equality of the two real exports is a drift guard; the
 * live lab proves the template actually reaches the summary payload.
 */

const compactionV2 = () => import("../../rigel-v2-native-compaction-context.mjs")

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "compaction.template",
    family: "compaction",
    oracle: "compaction.template",
    why: "V2's compaction context template is the V1 template, byte for byte (the artifact injected into the summary request).",
    loadV2: compactionV2,
    tolerance: { kind: "artifact-equality" },
    corpus: [{ name: "template" }],
    observeV1: (v1) => v1.COMPACTION_CONTEXT_PROMPT,
    observeV2: (v2) => v2.COMPACTION_CONTEXT_PROMPT,
    mutation: { target: "COMPACTION_CONTEXT_PROMPT", perturb: (real) => `${real}\nDRIFT`, onDisk: { find: "export const COMPACTION_CONTEXT_PROMPT =", replace: 'export const COMPACTION_CONTEXT_PROMPT = "";\nconst __orig_COMPACTION_CONTEXT_PROMPT =' } },
  },
]
