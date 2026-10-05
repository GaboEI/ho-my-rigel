/**
 * Pure ESM port of the V1 delegate-retry cores.
 *
 * The native OpenCode V2 runtime is plain ESM with no `node_modules` and the
 * lab stages only `.mjs` modules reachable from `rigel-v2-native.mjs`, so the
 * runtime cannot import the TypeScript V1 owners directly. The delegate-retry
 * after seam needs a concrete `detect` and `buildGuidance` to feed the T9 glue
 * (`decideDelegateRetry`), and this module is the faithful port that supplies
 * them.
 *
 * Ported byte-for-byte from the matching OmO revision:
 *   packages/delegate-core/src/retry-patterns.ts  -> DELEGATE_TASK_ERROR_PATTERNS,
 *     detectDelegateTaskError
 *   packages/delegate-core/src/retry-guidance.ts  -> buildRetryGuidance
 *
 * `rigel-v2-native-flow-after.test.mjs` imports the real V1 cores and pins
 * differential parity across a corpus, so an upstream table or template edit
 * that is not mirrored here fails the suite. The table keeps the V1
 * `missing_run_in_background` entry; the T3 verdict drops that class at the
 * glue (`decideDelegateRetry` routes it to the generic announce path) rather
 * than diverging from the V1 table.
 *
 * Pure module: no imports, no runtime dependencies, no I/O.
 */

/** V1 `DELEGATE_TASK_ERROR_PATTERNS`, copied in declared order. */
export const DELEGATE_TASK_ERROR_PATTERNS = [
  {
    pattern: "run_in_background",
    errorType: "missing_run_in_background",
    fixHint:
      "Add run_in_background=true (the standard spawn) or run_in_background=false for a short child whose result gates your very next call",
  },
  {
    pattern: "load_skills",
    errorType: "missing_load_skills",
    fixHint:
      "Add load_skills=[] parameter (empty array if no skills needed). Note: Calling Skill tool does NOT populate this.",
  },
  {
    pattern: "category OR subagent_type",
    errorType: "mutual_exclusion",
    fixHint:
      "Provide ONLY one of: category (e.g., 'general', 'quick') OR subagent_type (e.g., 'oracle', 'explore')",
  },
  {
    pattern: "Must provide either category or subagent_type",
    errorType: "missing_category_or_agent",
    fixHint: "Add either category='general' OR subagent_type='explore'",
  },
  {
    pattern: "Unknown category",
    errorType: "unknown_category",
    fixHint: "Use a valid category from the Available list in the error message",
  },
  {
    pattern: "Agent name cannot be empty",
    errorType: "empty_agent",
    fixHint: "Provide a non-empty subagent_type value",
  },
  {
    pattern: "Unknown agent",
    errorType: "unknown_agent",
    fixHint: "Use a valid agent from the Available agents list in the error message",
  },
  {
    pattern: "Cannot call primary agent",
    errorType: "primary_agent",
    fixHint:
      "Primary agents cannot be called via task. Use a subagent like 'explore', 'oracle', or 'librarian'",
  },
  {
    pattern: "Skills not found",
    errorType: "unknown_skills",
    fixHint: "Use valid skill names from the Available list in the error message",
  },
]

/**
 * V1 `detectDelegateTaskError`: requires a `[ERROR]` or `Invalid arguments`
 * gate token before testing the ordered substrings, else returns `null`.
 */
export function detectDelegateTaskError(output) {
  if (typeof output !== "string") return null
  if (!output.includes("[ERROR]") && !output.includes("Invalid arguments")) return null

  for (const errorPattern of DELEGATE_TASK_ERROR_PATTERNS) {
    if (output.includes(errorPattern.pattern)) {
      return {
        errorType: errorPattern.errorType,
        originalOutput: output,
      }
    }
  }

  return null
}

function extractAvailableList(output) {
  const availableMatch = output.match(/Available[^:]*:\s*(.+)$/m)
  return availableMatch ? availableMatch[1].trim() : null
}

/**
 * V1 `buildRetryGuidance`: byte-identical corrective text for a detected error.
 * The unknown-type fallback matches V1 exactly.
 */
export function buildRetryGuidance(errorInfo) {
  const pattern = DELEGATE_TASK_ERROR_PATTERNS.find(
    (entry) => entry.errorType === errorInfo?.errorType
  )

  if (!pattern) {
    return `[task ERROR] Fix the error and retry with correct parameters.`
  }

  let guidance = `
 [task CALL FAILED - IMMEDIATE RETRY REQUIRED]

 **Error Type**: ${errorInfo.errorType}
 **Fix**: ${pattern.fixHint}
 `

  const availableList = extractAvailableList(errorInfo.originalOutput ?? "")
  if (availableList) {
    guidance += `\n**Available Options**: ${availableList}\n`
  }

  guidance += `
 **Action**: Retry task NOW with corrected parameters.

 Example of CORRECT call:
 \`\`\`
 task(
   description="Task description",
   prompt="Detailed prompt...",
   category="unspecified-low",  // OR subagent_type="explore"
   run_in_background=true,
   load_skills=[]
 )
 \`\`\`
 `

  return guidance
}
