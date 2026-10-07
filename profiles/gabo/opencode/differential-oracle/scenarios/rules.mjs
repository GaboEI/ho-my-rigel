/** Scenario family: rules. */
/**
 * Owner V1: packages/rules-engine/src/engine/{parser,matcher}.ts
 * Mirror V2: rigel-v2-native-rules.mjs
 */

const rulesV2 = () => import("../../rigel-v2-native-rules.mjs")

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "rules.parse",
    family: "rules",
    oracle: "rules-engine.engine",
    why: "V2 parses rule frontmatter to the same globs + body as V1 (applyTo/globs normalization).",
    loadV2: rulesV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const parsed = v1.parseRule(input.text)
      return { globs: parsed.frontmatter.globs ?? parsed.frontmatter.applyTo ?? null, body: parsed.body }
    },
    observeV2: (v2, input) => {
      const parsed = v2.parseRuleFrontmatter(input.text)
      return { globs: parsed.metadata.globs ?? parsed.metadata.applyTo ?? null, body: parsed.body }
    },
    corpus: [
      { name: "applyTo", text: "---\napplyTo: src/**\n---\nBody A" },
      { name: "globs", text: '---\nglobs: "*.ts"\n---\nBody B' },
      { name: "alwaysApply", text: "---\nalwaysApply: true\nglobs: x\n---\nBody D" },
      { name: "no frontmatter", text: "Just body" },
      { name: "blank frontmatter", text: "---\n---\nBody E" },
    ],
    mutation: { target: "parseRuleFrontmatter", perturb: () => () => ({ metadata: {}, body: "" }) },
  },
  {
    id: "rules.match",
    family: "rules",
    oracle: "rules-engine.engine",
    why: "V2 decides rule applicability (glob / alwaysApply / no-match, negatives excluded) exactly as V1 matchRule.",
    loadV2: rulesV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const result = v1.matchRule({
        frontmatter: input.frontmatter,
        isSingleFile: false,
        pathBases: { projectRelative: input.projectRelative, basename: input.basename },
      })
      const reasonKind = typeof result.reason === "string" ? result.reason : result.reason?.kind
      const kind = !result.matched ? "no-match" : reasonKind === "alwaysApply" ? "alwaysApply" : "glob"
      return { matched: result.matched, kind }
    },
    observeV2: (v2, input) => {
      const reason = v2.matchRuleReason(input.frontmatter, `/repo/${input.projectRelative}`, "/repo")
      const kind = reason === undefined ? "no-match" : reason === "alwaysApply" ? "alwaysApply" : "glob"
      return { matched: reason !== undefined, kind }
    },
    corpus: [
      { name: "glob match", frontmatter: { globs: "src/**" }, projectRelative: "src/a.ts", basename: "a.ts" },
      { name: "glob miss", frontmatter: { globs: "src/**" }, projectRelative: "lib/a.ts", basename: "a.ts" },
      { name: "alwaysApply", frontmatter: { alwaysApply: true }, projectRelative: "x.ts", basename: "x.ts" },
      { name: "negative excludes", frontmatter: { globs: ["src/**", "!src/secret/**"] }, projectRelative: "src/secret/a.ts", basename: "a.ts" },
      { name: "applyTo ts", frontmatter: { applyTo: "**/*.ts" }, projectRelative: "a.ts", basename: "a.ts" },
      { name: "no patterns", frontmatter: {}, projectRelative: "a.ts", basename: "a.ts" },
    ],
    mutation: { target: "matchRuleReason", perturb: () => () => undefined },
  },
]
