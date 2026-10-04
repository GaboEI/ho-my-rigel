/**
 * Canonical OpenCode V2 model fallback chains for Oh My Rigel.
 *
 * Data-only port of the matching OmO revision:
 *   packages/model-core/src/agent-model-requirements.ts   (11 agents)
 *   packages/model-core/src/category-model-requirements.ts (9 categories)
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so the
 * chains live here as plain data. `rigel-v2-native-model-chains.test.mjs`
 * imports the TS sources and pins deep equality, so drift fails the suite.
 *
 * `requiresAnyModel` / `requiresProvider` / top-level `variant` flags from the
 * TS records are intentionally NOT ported: they gate whether an agent is
 * selectable at all (Tasks 11+), not the per-request fallback walk this module
 * owns. The fallback chains themselves are byte-faithful.
 *
 * Provider affinity at the HTTP boundary: `http.request` runs AFTER V2 has
 * already selected the provider route, endpoint, and credentials. Rewriting
 * only `body.model` cannot switch provider, so a rung on another provider would
 * be sent down the active provider's route (a cross-provider misroute, not a
 * fallback). Callers that resolve at that boundary MUST pass `sameProviderAs`
 * so selection stays on the active provider.
 *
 * Cross-provider fallback IS supported at the pre-selection boundaries, where
 * V2 has not chosen a provider yet and a provider switch is legitimate:
 *   - proactive: `registerNativeAgents` resolves each agent's starting model
 *     during `agent.transform`, before `agent.reload`;
 *   - reactive: `session.switchModel({ sessionID, model: { providerID, id } })`
 *     accepts a providerID and changes the session model before the next
 *     request.
 * Those callers omit `sameProviderAs`, so the full chain is walked across
 * providers. This module does not simulate either boundary; it only resolves.
 */

export const AGENT_MODEL_CHAINS = {
  sisyphus: [
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "max" },
    { providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode", "bailian-coding-plan", "moonshotai-cn", "firmware", "ollama-cloud", "aihubmix"], model: "kimi-k3" },
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["zai-coding-plan", "opencode", "bailian-coding-plan"], model: "glm-5.2" },
    { providers: ["opencode"], model: "big-pickle" },
  ],
  hephaestus: [
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-6-sol", variant: "medium" },
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-5.6-sol", variant: "medium" },
  ],
  oracle: [
    { providers: ["openai", "chatgpt-subscription", "opencode"], model: "gpt-5.6-sol", variant: "xhigh" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "high" },
    { providers: ["google", "github-copilot", "opencode"], model: "gemini-3.1-pro", variant: "high" },
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "max" },
    { providers: ["opencode-go"], model: "glm-5.2" },
  ],
  librarian: [
    { providers: ["kimi-for-coding"], model: "kimi-for-coding-highspeed", variant: "off" },
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-flash", variant: "max" },
    { providers: ["opencode-go", "bailian-coding-plan"], model: "qwen3.7-plus" },
    { providers: ["opencode-go"], model: "minimax-m2.7" },
    { providers: ["anthropic", "github-copilot"], model: "claude-haiku-4-5" },
  ],
  explore: [
    { providers: ["kimi-for-coding"], model: "kimi-for-coding-highspeed", variant: "off" },
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-flash", variant: "max" },
    { providers: ["opencode-go", "bailian-coding-plan"], model: "qwen3.7-plus" },
    { providers: ["opencode-go"], model: "minimax-m2.7" },
    { providers: ["anthropic", "github-copilot"], model: "claude-haiku-4-5" },
  ],
  "multimodal-looker": [
    { providers: ["openai", "chatgpt-subscription", "opencode"], model: "gpt-5.6-sol", variant: "low" },
    { providers: ["opencode-go"], model: "kimi-k3" },
    { providers: ["zai-coding-plan"], model: "glm-4.6v" },
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-5-nano" },
  ],
  prometheus: [
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-fable-5-1", variant: "xhigh" },
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "max" },
    { providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode"], model: "kimi-k3", variant: "max" },
  ],
  metis: [
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-fable-5-1", variant: "max" },
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "max" },
    { providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode"], model: "kimi-k3", variant: "max" },
  ],
  momus: [
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-6-astra", variant: "xhigh" },
    { providers: ["github-copilot"], model: "gpt-6-astra", variant: "high" },
    { providers: ["openai", "chatgpt-subscription", "opencode"], model: "gpt-6-astra", variant: "high" },
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "max" },
    { providers: ["google", "github-copilot", "opencode"], model: "gemini-3.1-pro", variant: "high" },
    { providers: ["opencode-go"], model: "glm-5.2" },
  ],
  atlas: [
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-sonnet-5" },
    { providers: ["opencode-go"], model: "kimi-k3" },
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["opencode-go"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go"], model: "minimax-m2.7" },
  ],
  "sisyphus-junior": [
    { providers: ["anthropic", "github-copilot", "opencode"], model: "claude-sonnet-5" },
    { providers: ["opencode-go"], model: "kimi-k3" },
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["opencode-go"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go"], model: "minimax-m2.7" },
    { providers: ["opencode"], model: "big-pickle" },
  ],
}

export const CATEGORY_MODEL_CHAINS = {
  "visual-engineering": [
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-fable-5-1", variant: "max" },
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "max" },
    { providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode"], model: "kimi-k3", variant: "max" },
  ],
  ultrabrain: [
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-6-astra", variant: "max" },
    { providers: ["github-copilot"], model: "gpt-6-astra", variant: "max" },
    { providers: ["openai", "chatgpt-subscription", "opencode"], model: "gpt-6-astra", variant: "max" },
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-5.6-sol", variant: "max" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "max" },
    { providers: ["openai", "chatgpt-subscription", "opencode"], model: "gpt-5.6-sol", variant: "max" },
  ],
  "deep-low": [
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-6.1-sol", variant: "medium" },
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-6.1-sol-fast", variant: "medium" },
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-5.6-sol-fast", variant: "medium" },
  ],
  "deep-high": [
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-6-astra", variant: "high" },
  ],
  artistry: [
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-fable-5-1", variant: "max" },
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "max" },
    { providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode"], model: "kimi-k3", variant: "max" },
  ],
  quick: [
    { providers: ["openai", "chatgpt-subscription"], model: "gpt-6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-flash", variant: "off" },
    { providers: ["qwen-token-plan", "alibaba-token-plan", "bailian-coding-plan"], model: "qwen3.6-flash", variant: "low" },
    { providers: ["opencode-go"], model: "minimax-m3", variant: "max" },
    { providers: ["opencode-go"], model: "minimax-m2.7", variant: "max" },
    { providers: ["xai"], model: "grok-4.20-0309-non-reasoning" },
    { providers: ["anthropic", "anthropic-api", "github-copilot"], model: "claude-haiku-4-5", variant: "off" },
    { providers: ["zai-coding-plan"], model: "glm-5.3-flash", variant: "low" },
    { providers: ["xiaomi"], model: "mimo-v2.6-flash", variant: "low" },
  ],
  "unspecified-low": [
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-sonnet-5-5", variant: "medium" },
    { providers: ["xiaomi", "opencode-go"], model: "mimo-v2.6-pro", variant: "max" },
    { providers: ["xai", "github-copilot", "opencode-go"], model: "grok-4.7", variant: "xhigh" },
    { providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"], model: "gpt-5.6-terra", variant: "high" },
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-sonnet-5", variant: "low" },
    { providers: ["qwen-token-plan", "alibaba-token-plan", "qwen-token-plan-cn", "alibaba-token-plan-cn"], model: "qwen3.8-max-preview", variant: "max" },
    { providers: ["deepseek", "opencode-go"], model: "deepseek-v4-pro", variant: "max" },
    { providers: ["xiaomi", "opencode-go"], model: "mimo-v2.5-pro", variant: "max" },
  ],
  "unspecified-high": [
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "medium" },
    { providers: ["zai-coding-plan", "opencode-go"], model: "glm-5.3", variant: "max" },
    { providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode"], model: "kimi-k3", variant: "max" },
  ],
  writing: [
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-opus-5-5", variant: "low" },
    { providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"], model: "claude-opus-4-6", variant: "max" },
  ],
}

function comparable(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Stable `provider/id` key for a V2 model row, or undefined when malformed. */
export function modelKey(model) {
  if (!model || typeof model !== "object") return undefined
  const providerID = model.providerID ?? model.provider
  const id = model.id ?? model.modelID
  return typeof providerID === "string" && typeof id === "string" ? `${providerID}/${id}` : undefined
}

/**
 * Normalize a model reference into `{ providerID?, id, variant? }`. Accepts a
 * V2 model row, an already-parsed ref, `provider/id`, `provider/id(variant)`,
 * or a bare model id (provider unknown).
 */
export function parseModel(value) {
  if (value && typeof value === "object") {
    const id = value.id ?? value.modelID
    if (typeof id !== "string" || id.length === 0) return undefined
    const providerID = value.providerID ?? value.provider
    return {
      ...(typeof providerID === "string" && providerID ? { providerID } : {}),
      id,
      ...(typeof value.variant === "string" && value.variant ? { variant: value.variant } : {}),
    }
  }
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const match = /^([^/]+)\/(.+?)(?:\(([^)]+)\))?$/.exec(trimmed)
  if (!match) return { id: trimmed }
  return { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) }
}

/**
 * Provider-scoped availability check. When the reference names a provider the
 * match MUST be that provider; a bare id matches any provider. A row is only
 * available when it is not explicitly disabled.
 *
 * When `sameProviderAs` is set, a bare reference is additionally pinned to that
 * provider, so an available bare id on a different provider does not count.
 */
export function isModelAvailable(currentModel, availableModels, sameProviderAs) {
  const configured = parseModel(currentModel)
  if (!configured) return false
  const rows = Array.isArray(availableModels) ? availableModels : []
  const constraint = typeof sameProviderAs === "string" && sameProviderAs ? sameProviderAs : undefined
  if (constraint && configured.providerID && configured.providerID !== constraint) return false
  return rows.some((row) => {
    if (row?.enabled === false) return false
    const parsed = parseModel(modelKey(row))
    if (!parsed) return false
    if (parsed.id !== configured.id && comparable(parsed.id) !== comparable(configured.id)) return false
    if (configured.providerID && parsed.providerID !== configured.providerID) return false
    if (constraint && parsed.providerID !== constraint) return false
    return true
  })
}

function failedKeys(failedModels) {
  const keys = new Set()
  if (failedModels instanceof Set) {
    for (const value of failedModels) keys.add(String(value))
  } else if (Array.isArray(failedModels)) {
    for (const value of failedModels) keys.add(String(value))
  } else if (failedModels && typeof failedModels === "object") {
    for (const value of Object.values(failedModels)) keys.add(String(value))
  }
  return keys
}

function isFailed(entry, failed) {
  if (!entry || failed.size === 0) return false
  if (typeof entry === "string") {
    const parsed = parseModel(entry)
    return failed.has(entry) || Boolean(parsed && failed.has(parsed.id))
  }
  const id = typeof entry.model === "string" ? entry.model : (typeof entry.id === "string" ? entry.id : undefined)
  if (!id) return false
  if (failed.has(id)) return true
  const providers = Array.isArray(entry.providers)
    ? entry.providers
    : (typeof entry.providerID === "string" ? [entry.providerID] : [])
  return providers.some((providerID) => failed.has(`${providerID}/${id}`))
}

/**
 * Find the first available model for one chain rung, restricted to the rung's
 * declared providers. Never accepts a model id under an unrelated provider.
 *
 * When `sameProviderAs` is set the rung's declared providers are intersected
 * with it BEFORE the provider loop, so a rung that is only reachable on another
 * provider is skipped rather than selected-then-rejected. That distinction
 * matters: a rung that lists both providers must still be selected on the
 * active provider instead of being discarded.
 */
function findRungAvailable(entry, availableModels, sameProviderAs) {
  if (!entry || typeof entry.model !== "string") return undefined
  const declared = Array.isArray(entry.providers) ? entry.providers : []
  const providers = sameProviderAs
    ? declared.filter((providerID) => providerID === sameProviderAs)
    : declared
  if (providers.length === 0) return undefined
  for (const providerID of providers) {
    const row = (availableModels ?? []).find((candidate) => {
      if (candidate?.enabled === false) return false
      const parsed = parseModel(modelKey(candidate))
      if (!parsed) return false
      return parsed.providerID === providerID
        && (parsed.id === entry.model || comparable(parsed.id) === comparable(entry.model))
    })
    if (row) {
      const parsed = parseModel(modelKey(row))
      return { ...parsed, ...(entry.variant ? { variant: entry.variant } : {}) }
    }
  }
  return undefined
}

/**
 * Resolve which model a request should use.
 *
 * Returns the normalized current model when it is available and not failed.
 * Otherwise walks the chain and returns the first rung that is reachable on one
 * of its declared providers and not marked failed. Returns undefined when
 * nothing is reachable, so callers leave the payload untouched.
 *
 * `sameProviderAs` pins resolution to one provider (typically the provider V2
 * already selected). When set, only a model whose row is on that provider can
 * be returned, the current-model early return is provider-scoped for bare ids,
 * and a chain with no rung on that provider resolves to undefined.
 */
export function resolveFallbackModel({ chain, availableModels, currentModel, failedModels, sameProviderAs } = {}) {
  const failed = failedKeys(failedModels)
  const rows = Array.isArray(availableModels) ? availableModels : []
  const constraint = typeof sameProviderAs === "string" && sameProviderAs ? sameProviderAs : undefined
  if (currentModel !== undefined && currentModel !== null && currentModel !== "") {
    const normalized = parseModel(currentModel)
    if (normalized && isModelAvailable(normalized, rows, constraint) && !isFailed(normalized, failed)) {
      return normalized
    }
  }
  if (!Array.isArray(chain)) return undefined
  for (const entry of chain) {
    if (isFailed(entry, failed)) continue
    const selected = findRungAvailable(entry, rows, constraint)
    if (selected) return selected
  }
  return undefined
}

function normalizeAgentName(name) {
  const raw = String(name ?? "").trim().toLocaleLowerCase()
  if (!raw) return ""
  // V2 surfaces display-cased agent names such as `Sisyphus - ultraworker`;
  // the canonical chain key is the base identifier before the display suffix.
  return raw.split(/\s+-\s+/)[0].trim()
}

/** Canonical fallback chain for an agent name/id, or undefined when unknown. */
export function agentChain(name) {
  const chain = AGENT_MODEL_CHAINS[normalizeAgentName(name)]
  return Array.isArray(chain) ? chain : undefined
}

/** Canonical fallback chain for a category name, or undefined when unknown. */
export function categoryChain(name) {
  const chain = CATEGORY_MODEL_CHAINS[String(name ?? "").trim().toLocaleLowerCase()]
  return Array.isArray(chain) ? chain : undefined
}
