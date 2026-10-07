/**
 * Differential-oracle helper for the Rigel native V2 suites.
 *
 * The V2 migration mirrors several pure V1 cores (keyword detection, ultrawork
 * source routing, delegate retry patterns). The differential strategy runs the
 * same corpus through both the V1 core and the V2 mirror and compares the two.
 * This helper is the single sanctioned way to obtain the V1 side: it imports
 * the real core module by its repo-relative URL.
 *
 * Fallback contract. The native runtime and its tests must run without
 * `node_modules`, so a V1 module can legitimately be unresolvable hermetically
 * (its transitive `@oh-my-opencode/*` or `@opencode-ai/*` imports missing).
 * When that happens `loadV1Oracle` does NOT substitute a hand-copied mirror: a
 * copied implementation would drift from V1 and make a "differential" pass
 * meaningless. It returns `{ source: "fallback", module: null, degraded: true,
 * reason }`, and the caller records a `blocked` verdict instead of asserting
 * V1 parity. A red/green parity result is only claimed when the real V1 core
 * ran (`source: "v1"`).
 */

const ORACLE_SOURCE = {
  "keyword-detector.detector": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/keyword-detector/detector.ts", import.meta.url).href,
    requiredExports: ["detectKeywordsWithType", "extractPromptText"],
    description: "V1 keyword detector and prompt-text extraction",
  },
  "keyword-detector.ultrawork.source-detector": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/keyword-detector/ultrawork/source-detector.ts", import.meta.url).href,
    requiredExports: ["getUltraworkSource", "isPlannerAgent", "isNonOmoAgent"],
    description: "V1 ultrawork agent/model source routing",
  },
  "delegate-core.retry-patterns": {
    importUrl: new URL("../../../../packages/delegate-core/src/retry-patterns.ts", import.meta.url).href,
    requiredExports: ["detectDelegateTaskError", "DELEGATE_TASK_ERROR_PATTERNS"],
    description: "V1 delegate task error detection",
  },
  "delegate-core.retry-guidance": {
    importUrl: new URL("../../../../packages/delegate-core/src/retry-guidance.ts", import.meta.url).href,
    requiredExports: ["buildRetryGuidance"],
    description: "V1 delegate task retry guidance",
  },
  "keyword-detector.ultrawork.messages": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/keyword-detector/ultrawork/index.ts", import.meta.url).href,
    requiredExports: ["ULTRAWORK_DEFAULT_MESSAGE", "ULTRAWORK_GPT_MESSAGE", "ULTRAWORK_GEMINI_MESSAGE", "ULTRAWORK_GLM_MESSAGE", "ULTRAWORK_PLANNER_SECTION"],
    description: "V1 ultrawork directive message bodies",
  },
  "keyword-detector.constants": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/keyword-detector/constants.ts", import.meta.url).href,
    requiredExports: ["TEAM_MESSAGE", "HYPERPLAN_MESSAGE"],
    description: "V1 team and hyperplan directive message bodies",
  },
  "delegate-task.constants": {
    importUrl: new URL("../../../../packages/omo-opencode/src/tools/delegate-task/constants.ts", import.meta.url).href,
    requiredExports: ["isCoordinatorAgent", "COORDINATOR_AGENT_NAMES"],
    description: "V1 coordinator agent guard",
  },
  "delegate-task.subagent-discovery": {
    importUrl: new URL("../../../../packages/omo-opencode/src/tools/delegate-task/subagent-discovery.ts", import.meta.url).href,
    requiredExports: ["isDemotedPlanAgent", "isTaskCallableAgentMode", "listCallableAgentNames"],
    description: "V1 subagent callable/demoted classification",
  },
  "model-core.agent-requirements": {
    importUrl: new URL("../../../../packages/model-core/src/agent-model-requirements.ts", import.meta.url).href,
    requiredExports: ["AGENT_MODEL_REQUIREMENTS"],
    description: "V1 per-agent model fallback chains",
  },
  "model-core.category-requirements": {
    importUrl: new URL("../../../../packages/model-core/src/category-model-requirements.ts", import.meta.url).href,
    requiredExports: ["CATEGORY_MODEL_REQUIREMENTS"],
    description: "V1 per-category model fallback chains",
  },
  "model-core.error-classifier": {
    importUrl: new URL("../../../../packages/model-core/src/model-error-classifier.ts", import.meta.url).href,
    requiredExports: ["getNextFallback", "hasMoreFallbacks", "selectFallbackProvider"],
    description: "V1 model fallback rung selection",
  },
  "model-core.model-string-parser": {
    importUrl: new URL("../../../../packages/model-core/src/model-string-parser.ts", import.meta.url).href,
    requiredExports: ["parseModelString", "parseVariantFromModelID"],
    description: "V1 model string parsing",
  },
  "model-core.provider-transform": {
    importUrl: new URL("../../../../packages/model-core/src/provider-model-id-transform.ts", import.meta.url).href,
    requiredExports: ["transformModelForProvider"],
    description: "V1 provider model id transform",
  },
  "rules-engine.engine": {
    importUrl: new URL("../../../../packages/rules-engine/src/engine/index.ts", import.meta.url).href,
    requiredExports: ["parseRule", "matchRule", "normalizeGlobs", "truncateRule", "truncateBudget", "isNeverTruncatedRule"],
    description: "V1 rules engine parse/match/truncate",
  },
  "recovery.edit": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/edit-error-recovery/index.ts", import.meta.url).href,
    requiredExports: ["EDIT_ERROR_PATTERNS", "EDIT_ERROR_REMINDER", "createEditErrorRecoveryHook"],
    description: "V1 edit error recovery patterns, reminder and hook",
  },
  "recovery.json": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/json-error-recovery/index.ts", import.meta.url).href,
    requiredExports: ["JSON_ERROR_PATTERNS", "JSON_ERROR_REMINDER", "createJsonErrorRecoveryHook"],
    description: "V1 JSON error recovery patterns, reminder and hook",
  },
  "recovery.webfetch": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/webfetch-redirect-guard/redirect-resolution.ts", import.meta.url).href,
    requiredExports: ["resolveWebFetchRedirects"],
    description: "V1 webfetch redirect resolution",
  },
  "agents.frontier-guard": {
    importUrl: new URL("../../../../packages/omo-opencode/src/agents/frontier-tool-schema-guard.ts", import.meta.url).href,
    requiredExports: ["getFrontierToolSchemaPermission"],
    description: "V1 frontier model tool schema permission",
  },
  "plan-format.effort": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/plan-format-validator/hook.ts", import.meta.url).href,
    requiredExports: ["effortBandForDuration", "normalizePlanEffort"],
    description: "V1 plan effort band normalization",
  },
  "compaction.template": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/compaction-context-injector/compaction-context-prompt.ts", import.meta.url).href,
    requiredExports: ["COMPACTION_CONTEXT_PROMPT"],
    description: "V1 compaction context prompt template",
  },
  "compaction.session": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/compaction-context-injector/session-id.ts", import.meta.url).href,
    requiredExports: ["isCompactionAgent", "resolveSessionID"],
    description: "V1 compaction agent detection",
  },
  "goal.validation": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/goal/validation.ts", import.meta.url).href,
    requiredExports: ["validateObjective", "MAX_OBJECTIVE_LENGTH"],
    description: "V1 goal objective validation",
  },
  "goal.command-arguments": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/goal/command-arguments.ts", import.meta.url).href,
    requiredExports: ["parseGoalCommand"],
    description: "V1 goal command parsing",
  },
  "goal.prompt": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/goal/prompt.ts", import.meta.url).href,
    requiredExports: ["buildContinuationPrompt", "buildResumePrompt"],
    description: "V1 goal continuation and resume prompts",
  },
  "goal.types": {
    importUrl: new URL("../../../../packages/omo-opencode/src/hooks/goal/types.ts", import.meta.url).href,
    requiredExports: ["GOAL_STATUS_VALUES"],
    description: "V1 goal status values",
  },
  "skills.scope-priority": {
    importUrl: new URL("../../../../packages/skills-loader-core/src/features/opencode-skill-loader/merger/scope-priority.ts", import.meta.url).href,
    requiredExports: ["SCOPE_PRIORITY"],
    description: "V1 skill scope priority table",
  },
  "skills.allowed-tools": {
    importUrl: new URL("../../../../packages/skills-loader-core/src/features/opencode-skill-loader/allowed-tools-parser.ts", import.meta.url).href,
    requiredExports: ["parseAllowedTools"],
    description: "V1 skill allowed-tools parser",
  },
  "skills.matcher": {
    importUrl: new URL("../../../../packages/skills-loader-core/src/tools/skill/skill-matcher.ts", import.meta.url).href,
    requiredExports: ["matchSkillByName", "findPartialMatches"],
    description: "V1 skill name matching",
  },
  "skills.body": {
    importUrl: new URL("../../../../packages/omo-opencode/src/tools/skill/skill-body.ts", import.meta.url).href,
    requiredExports: ["extractSkillBody"],
    description: "V1 skill body extraction",
  },
}

/** Frozen list of oracle ids accepted by `loadV1Oracle`. */
export const V1_ORACLE_IDS = Object.freeze(Object.keys(ORACLE_SOURCE))

/**
 * Load the real V1 core for a differential comparison.
 *
 * @param {string} id one of `V1_ORACLE_IDS`
 * @param {{ importModule?: (url: string) => Promise<object> }} [options]
 *   `importModule` is injectable so a test can force the unresolved-import
 *   fallback without breaking the real environment.
 * @returns {Promise<{ id: string, source: "v1" | "fallback", module: object | null, degraded: boolean, reason: string | null }>}
 */
export async function loadV1Oracle(id, options = {}) {
  const entry = ORACLE_SOURCE[id]
  if (!entry) {
    throw new Error(`loadV1Oracle: unknown oracle id "${id}"`)
  }
  const importModule = typeof options.importModule === "function"
    ? options.importModule
    : (url) => import(url)
  try {
    const module = await importModule(entry.importUrl)
    const missing = entry.requiredExports.filter((name) => module?.[name] === undefined)
    if (missing.length > 0) {
      return {
        id,
        source: "fallback",
        module: null,
        degraded: true,
        reason: `missing exports: ${missing.join(", ")}`,
      }
    }
    return { id, source: "v1", module, degraded: false, reason: null }
  } catch (error) {
    return {
      id,
      source: "fallback",
      module: null,
      degraded: true,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
