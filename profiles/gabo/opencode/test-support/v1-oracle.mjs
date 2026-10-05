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
