/**
 * Scenario family: ultrawork / keyword detection.
 *
 * Owner V1: packages/omo-opencode/src/hooks/keyword-detector/**
 * Mirror V2: profiles/gabo/opencode/rigel-v2-keyword-core.mjs
 *
 * Observables are behavioral (detected keyword types, source routing, text
 * guards), never prompt bytes. Every corpus row is a positive or a negative
 * case, and each scenario declares a mutation that must flip it RED.
 */

const detector = () => import("../../rigel-v2-keyword-core.mjs")

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "ultrawork.detection",
    family: "ultrawork",
    oracle: "keyword-detector.detector",
    why: "V2 detectKeywordTypes reproduces V1 detectKeywordsWithType over the exact keyword corpus, including negatives (ultraworker, code blocks, disabled keywords).",
    loadV2: detector,
    tolerance: { kind: "ordered" },
    observeV1: (v1, input) =>
      v1
        .detectKeywordsWithType(input.text, undefined, undefined, input.disabled, input.enabled)
        .map((keyword) => keyword.type),
    observeV2: (v2, input) =>
      v2.detectKeywordTypes(input.text, {
        disabledKeywords: input.disabled,
        enabledExpansions: input.enabled,
      }),
    corpus: [
      { name: "ultrawork", text: "do ultrawork now" },
      { name: "ulw", text: "ulw" },
      { name: "uppercase", text: "PLEASE ULTRAWORK" },
      { name: "ultraworker negative", text: "ultraworker" },
      { name: "team mode", text: "use team mode" },
      { name: "team-mode", text: "team-mode" },
      { name: "team double space negative", text: "team  mode" },
      { name: "hyperplan", text: "hyperplan this" },
      { name: "hpp", text: "hpp" },
      { name: "hpp extension negative", text: "interface.hpp" },
      { name: "combo", text: "hpp ulw" },
      { name: "combo reverse", text: "ulw hpp" },
      { name: "non adjacent", text: "hpp do ulw" },
      { name: "fenced code negative", text: "```\nultrawork\n```" },
      { name: "inline code negative", text: "`ulw`" },
      { name: "code then prose", text: "```\nulw\n```\nbut team mode yes" },
      { name: "combined", text: "ulw team mode" },
      { name: "disabled team", text: "ulw team mode", disabled: ["team"] },
      { name: "disabled ultrawork drops combo", text: "ulw hpp", disabled: ["ultrawork"] },
      { name: "disabled hyperplan drops combo", text: "ulw hpp", disabled: ["hyperplan"] },
      { name: "allowlist keeps team", text: "ulw hpp team mode", enabled: ["team"] },
      { name: "empty allowlist blocks all", text: "ulw hpp team mode", enabled: [] },
      { name: "allowlist keeps combo", text: "hpp ulw team mode", enabled: ["hyperplan-ultrawork"] },
      { name: "plain text negative", text: "hello world" },
    ],
    mutation: { target: "detectKeywordTypes", perturb: () => () => [] },
  },
  {
    id: "ultrawork.source-routing",
    family: "ultrawork",
    oracle: "keyword-detector.ultrawork.source-detector",
    why: "V2 source routing (planner/non-OMO/model family) reproduces V1 getUltraworkSource and its predicates.",
    loadV2: detector,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => ({
      source: v1.getUltraworkSource(input.agent, input.model),
      planner: v1.isPlannerAgent(input.agent),
      nonOmo: v1.isNonOmoAgent(input.agent),
    }),
    observeV2: (v2, input) => ({
      source: v2.getUltraworkSource(input.agent, input.model),
      planner: v2.isPlannerAgent(input.agent),
      nonOmo: v2.isNonOmoAgent(input.agent),
    }),
    corpus: [
      { name: "planner", agent: "prometheus", model: "anthropic/claude-opus-5" },
      { name: "plan-mode", agent: "plan-mode", model: undefined },
      { name: "gpt", agent: "sisyphus", model: "openai/gpt-5.5" },
      { name: "gemini", agent: "sisyphus", model: "google/gemini-3-pro" },
      { name: "glm", agent: "sisyphus", model: "zai/glm-5" },
      { name: "default", agent: "sisyphus", model: "anthropic/claude-sonnet-4-6" },
      { name: "empty", agent: undefined, model: undefined },
      { name: "non-omo builder", agent: "builder", model: "openai/gpt-5.5" },
    ],
    mutation: { target: "getUltraworkSource", perturb: () => () => "default" },
  },
  {
    id: "ultrawork.text-guards",
    family: "ultrawork",
    oracle: "keyword-detector.detector",
    why: "V2 prompt-text extraction, code-block stripping and slash-command detection reproduce the V1 guards exactly.",
    loadV2: detector,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      if (input.kind === "extract") return v1.extractPromptText(input.parts)
      if (input.kind === "strip") return v1.removeCodeBlocks(input.text)
      return v1.looksLikeSlashCommand(input.text)
    },
    observeV2: (v2, input) => {
      if (input.kind === "extract") return v2.extractPromptText(input.parts)
      if (input.kind === "strip") return v2.removeCodeBlocks(input.text)
      return v2.looksLikeSlashCommand(input.text)
    },
    corpus: [
      { name: "extract real parts", kind: "extract", parts: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
      { name: "extract drops synthetic", kind: "extract", parts: [{ type: "text", text: "first", synthetic: true }, { type: "text", text: "second" }] },
      { name: "extract drops internal", kind: "extract", parts: [{ type: "text", text: "first\n<!-- OMO_INTERNAL_INITIATOR -->" }, { type: "text", text: "second" }] },
      { name: "extract skips files", kind: "extract", parts: [{ type: "file", path: "x" }, { type: "text", text: "hello" }] },
      { name: "strip fence then inline", kind: "strip", text: "```\nultrawork\n```\n`ulw` team mode" },
      { name: "strip plain", kind: "strip", text: "plain ulw" },
      { name: "slash true", kind: "slash", text: "/help ulw" },
      { name: "slash stop", kind: "slash", text: "/stop-continuation now" },
      { name: "slash false mid", kind: "slash", text: "please /help" },
      { name: "slash false digit", kind: "slash", text: "/1bad" },
    ],
    mutation: { target: "extractPromptText", perturb: (real) => (parts) => `${real(parts)}-x` },
  },
]
