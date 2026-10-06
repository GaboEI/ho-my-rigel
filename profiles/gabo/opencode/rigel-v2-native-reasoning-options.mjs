/**
 * Pure mapping from the V1 think-mode / chat.params reasoning semantics onto the
 * V2 `context` hook's semantic generation options.
 *
 * V2 exposes generation options (camelCase keys such as `reasoningEffort`,
 * `maxTokens`, `temperature`, `topP`, `textVerbosity`) that the provider adapter
 * translates into each provider's wire shape. The per-turn seam is therefore
 * `event.options`, driven by the CURRENT user message, which keeps unrelated
 * turns unmutated.
 *
 * No OpenCode imports; fully testable in isolation.
 */

const ENGLISH_PATTERN = /\b(?:ultrathink|think)\b/i

const MULTILINGUAL_KEYWORDS = [
  "생각", "검토", "제대로",
  "思考", "考虑", "考慮",
  "考え", "熟考",
  "सोच", "विचार",
  "تفكير", "تأمل",
  "চিন্তা", "ভাবনা",
  "думать", "думай", "размышлять", "размышляй",
  "pensar", "pense", "refletir", "reflita",
  "piensa", "reflexionar", "reflexiona",
  "penser", "réfléchir", "réfléchis",
  "denken", "denk", "nachdenken", "nadenken",
  "suy nghĩ", "cân nhắc",
  "düşün", "düşünmek",
  "pensare", "pensa", "riflettere", "rifletti",
  "คิด", "พิจารณา",
  "myśl", "myśleć", "zastanów",
  "berpikir", "pikir", "pertimbangkan",
  "думати", "роздумувати",
  "σκέψου", "σκέφτομαι",
  "myslet", "mysli", "přemýšlet",
  "gândește", "gândi", "reflectă",
  "tänka", "tänk", "fundera",
  "gondolkodj", "gondolkodni",
  "ajattele", "ajatella", "pohdi",
  "tænk", "tænke", "overvej",
  "tenk", "tenke", "gruble",
  "חשוב", "לחשוב", "להרהר",
  "fikir", "berfikir",
]

const COMBINED_THINK_PATTERN = new RegExp(
  `${ENGLISH_PATTERN.source}|${MULTILINGUAL_KEYWORDS.join("|")}`,
  "i",
)
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g
const INLINE_CODE_PATTERN = /`[^`]+`/g

export const REASONING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

export function stripCodeText(text) {
  return String(text ?? "").replace(CODE_BLOCK_PATTERN, " ").replace(INLINE_CODE_PATTERN, " ")
}

export function detectThinkKeyword(text) {
  return COMBINED_THINK_PATTERN.test(stripCodeText(text))
}

export function normalizeModelID(modelID) {
  return String(modelID ?? "").toLocaleLowerCase().replace(/(\d)\.(\d)/g, "$1-$2")
}

function baseModelID(modelID) {
  const normalized = normalizeModelID(modelID)
  const slash = normalized.lastIndexOf("/")
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

/**
 * The V1 owner treats a model whose id already carries the `-high` suffix as
 * already a high variant and declines to raise it. The V1 `getHighVariant`
 * rename map is intentionally not carried: V2 selects reasoning through model
 * variants and semantic options, and the rename map is unused by the V1 hook.
 */
export function isAlreadyHighVariant(modelID) {
  return baseModelID(modelID).endsWith("-high")
}

export function normalizeReasoningLevel(value) {
  if (typeof value !== "string") return undefined
  const level = value.trim().toLocaleLowerCase()
  if (level === "none") return "off"
  return REASONING_LEVELS.includes(level) ? level : undefined
}

/** V1 `reasoningEffortFromThinking`: an enabled budget maps to an effort band. */
export function reasoningEffortFromThinking(thinking) {
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return undefined
  if (thinking.type !== "enabled") return undefined
  const budget = thinking.budgetTokens
  if (typeof budget !== "number" || !Number.isFinite(budget)) return "high"
  if (budget >= 32000) return "high"
  if (budget >= 16000) return "medium"
  return "low"
}

/** The inverse band: the Anthropic thinking budget a reasoning level uses. */
export function thinkingBudgetForLevel(level) {
  switch (normalizeReasoningLevel(level)) {
    case "minimal": return 4000
    case "low": return 8000
    case "medium": return 16000
    case "high": return 32000
    case "xhigh": return 48000
    case "max": return 64000
    default: return undefined
  }
}

/** The V1 owner's Anthropic thinking budget for a raised turn (CLAUDE_THINKING_BUDGET_TOKENS). */
export const THINK_MODE_THINKING_BUDGET = 32000

/**
 * Resolve the per-turn V2 semantic options from an agent's request tuning plus the
 * current user message. V1 precedence: an explicit agent reasoning/variant wins;
 * otherwise the think keyword (skipping models that are already a high variant).
 *
 * The reasoning effect is emitted on BOTH portable carriers, matching the V1
 * chat.params owner: `reasoningEffort` (OpenAI protocols) and an Anthropic-style
 * `thinking` budget. Each adapter consumes its own key and ignores the other, so
 * one emission serves every model family.
 */
export function buildReasoningOptions({ tuning, currentTurnText, modelID, thinkModeEnabled = true } = {}) {
  const options = {}
  let explicitLevel
  let explicitBudget
  if (tuning && typeof tuning === "object" && !Array.isArray(tuning)) {
    if (tuning.temperature !== undefined) options.temperature = tuning.temperature
    if (tuning.top_p !== undefined) options.topP = tuning.top_p
    if (tuning.maxTokens !== undefined) options.maxTokens = tuning.maxTokens
    if (tuning.textVerbosity !== undefined) options.textVerbosity = tuning.textVerbosity
    if (tuning.thinking && tuning.thinking.type === "enabled" && typeof tuning.thinking.budgetTokens === "number") {
      explicitBudget = tuning.thinking.budgetTokens
    }
    explicitLevel = normalizeReasoningLevel(tuning.reasoning)
      ?? normalizeReasoningLevel(tuning.reasoningEffort)
      ?? reasoningEffortFromThinking(tuning.thinking)
  }
  if (explicitLevel !== undefined) {
    options.reasoningEffort = explicitLevel
    const budget = explicitBudget ?? thinkingBudgetForLevel(explicitLevel)
    if (budget !== undefined) options.thinking = { type: "enabled", budgetTokens: budget }
    return { options, source: "agent" }
  }
  const text = stripCodeText(currentTurnText)
  if (thinkModeEnabled && !isAlreadyHighVariant(modelID) && detectThinkKeyword(text)) {
    options.reasoningEffort = "high"
    options.thinking = { type: "enabled", budgetTokens: THINK_MODE_THINKING_BUDGET }
    return { options, source: "think" }
  }
  return { options, source: null }
}
