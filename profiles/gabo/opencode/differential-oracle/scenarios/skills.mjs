/** Scenario family: skills. */
/**
 * Owners V1: packages/skills-loader-core/src/features/opencode-skill-loader/{merger/scope-priority,allowed-tools-parser}.ts,
 *            packages/skills-loader-core/src/tools/skill/skill-matcher.ts
 * Mirror V2: rigel-v2-native-skills.mjs
 */

const skillsV2 = () => import("../../rigel-v2-native-skills.mjs")

const SKILLS = [
  { name: "Git-Master" },
  { name: "playwright" },
  { name: "Security-Review" },
]

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  {
    id: "skills.scope-priority",
    family: "skills",
    oracle: "skills.scope-priority",
    why: "V2 uses the identical skill scope priority map as V1.",
    loadV2: skillsV2,
    tolerance: { kind: "artifact-equality" },
    corpus: [{ name: "map" }],
    observeV1: (v1) => v1.SCOPE_PRIORITY,
    observeV2: (v2) => v2.SCOPE_PRIORITY,
    mutation: { target: "SCOPE_PRIORITY", perturb: (real) => ({ ...real, project: 999 }), onDisk: { find: "export const SCOPE_PRIORITY =", replace: "export const SCOPE_PRIORITY = {};\nconst __orig_SCOPE_PRIORITY =" } },
  },
  {
    id: "skills.allowed-tools",
    family: "skills",
    oracle: "skills.allowed-tools",
    why: "V2 parses a skill's allowed-tools frontmatter value exactly as V1.",
    loadV2: skillsV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.parseAllowedTools(input.value) ?? null,
    observeV2: (v2, input) => v2.parseAllowedTools(input.value) ?? null,
    corpus: [
      { name: "undefined", value: undefined },
      { name: "space separated", value: "read write edit" },
      { name: "array", value: ["read", "glob"] },
      { name: "blank", value: "   " },
    ],
    mutation: { target: "parseAllowedTools", perturb: () => () => [] },
  },
  {
    id: "skills.matching",
    family: "skills",
    oracle: "skills.matcher",
    why: "V2 resolves a requested skill name to the same skill as V1 (case-insensitive exact match).",
    loadV2: skillsV2,
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => v1.matchSkillByName(SKILLS, input.requested)?.name ?? null,
    observeV2: (v2, input) => v2.matchSkillByName(SKILLS, input.requested)?.name ?? null,
    corpus: [
      { name: "exact case-insensitive", requested: "git-master" },
      { name: "exact", requested: "playwright" },
      { name: "missing", requested: "nope" },
      { name: "partial not exact", requested: "git" },
    ],
    mutation: { target: "matchSkillByName", perturb: () => () => undefined },
  },
]
