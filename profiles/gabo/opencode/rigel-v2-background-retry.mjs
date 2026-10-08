// allow: SIZE_OK - one indivisible port of the V1 fallback decision (classifier
// import, provider model-id transform, chain navigation, retry gate, and the
// agent-not-found swap); the pieces share the budget and no-op contract the
// parity test pins as one behavior.
/**
 * Pure background-agent fallback-retry policy for Oh My Rigel's native OpenCode
 * V2 runtime.
 *
 * Plain-JS port of the matching OmO revision:
 *   packages/omo-opencode/src/features/background-agent/fallback-retry-handler.ts
 *     canRetry gate (73-81): (shouldRetryError || providerExhaustionEligible)
 *                            && chain non-empty && hasMoreFallbacks
 *     selection loop (93-131): walk the chain from attemptCount, skip
 *                            unreachable providers and no-op fallbacks (same
 *                            provider+model as the current model), budget = chain
 *                            length; no backoff, no sleep
 *   packages/model-core/src/model-error-classifier.ts
 *     hasMoreFallbacks (169-174), getNextFallback (159-164),
 *     canonicalizeModelID is local to the handler (24-26)
 *   packages/model-core/src/provider-model-id-transform.ts
 *     transformModelForProvider (65-67)
 *   packages/omo-opencode/src/features/background-agent/spawner/fallback-agent.ts
 *     FALLBACK_AGENT (4), isAgentNotFoundError (6-12)
 *
 * Error classification is delegated to `rigel-v2-background-error.mjs`, a pure
 * port of the model-core classifier. The decision core here is deterministic and
 * synchronous: no timers, no poller, no runtime dependencies. The caller owns
 * the actual re-launch; this module only decides whether and where to retry.
 *
 * `rigel-v2-background-retry.test.mjs` imports the real TS owners and pins
 * parity for the classifier, the transform, and the fallback navigation, so
 * upstream drift fails the suite.
 */

import {
  isProviderExhaustionFallbackEligible,
  shouldRetryError,
} from "./rigel-v2-background-error.mjs"

/** The agent a task falls back to when its configured agent is not registered. */
export const FALLBACK_AGENT = "general"

/**
 * Checks if there are more fallbacks available after the current attempt,
 * mirroring V1 `hasMoreFallbacks`. The chain length IS the retry budget.
 */
export function hasMoreFallbacks(fallbackChain, attemptCount) {
  return attemptCount < fallbackChain.length
}

/**
 * Gets the next fallback model from the chain based on attempt count, mirroring
 * V1 `getNextFallback`. Returns undefined when the chain is exhausted.
 */
export function getNextFallback(fallbackChain, attemptCount) {
  return fallbackChain[attemptCount]
}

/**
 * Canonicalize a model id for the no-op comparison, mirroring the handler-local
 * `canonicalizeModelID`: lowercase and treat `.` and `-` as equivalent.
 */
export function canonicalizeModelID(modelID) {
  return String(modelID).toLowerCase().replace(/\./g, "-")
}

function getErrorMessage(error) {
  if (typeof error === "string") {
    return error
  }
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

/**
 * Detects the OpenCode "agent not found" error, mirroring V1
 * `isAgentNotFoundError` (message contains "Agent not found" or "agent.name").
 */
export function isAgentNotFoundError(error) {
  const message = getErrorMessage(error)
  return message.includes("Agent not found") || message.includes("agent.name")
}

function inferSubProvider(model) {
  if (model.startsWith("claude-")) return "anthropic"
  if (model.startsWith("gpt-")) return "openai"
  if (model.startsWith("gemini-")) return "google"
  if (model.startsWith("grok-")) return "xai"
  if (model.startsWith("minimax-")) return "minimax"
  if (model.startsWith("kimi-")) return "moonshotai"
  if (model.startsWith("k3")) return "moonshotai"
  if (model.startsWith("glm-")) return "zai"
  return undefined
}

const CLAUDE_VERSION_DOT = /claude-(\w+)-(\d+)-(\d+)/g
const GEMINI_31_PRO_PREVIEW = /gemini-3\.1-pro(?!-)/g
const GEMINI_3_FLASH_PREVIEW = /(?<!antigravity-)gemini-3-flash(?!-)/g

function claudeVersionDot(model) {
  return model.replace(CLAUDE_VERSION_DOT, "claude-$1-$2.$3")
}

function applyGatewayTransforms(model) {
  return claudeVersionDot(model).replace(GEMINI_31_PRO_PREVIEW, "gemini-3.1-pro-preview")
}

/**
 * Provider-specific model id transform, mirroring V1
 * `transformModelForProvider`. The no-op comparison depends on it: the candidate
 * model is transformed for the selected provider before it is compared with the
 * current (already-transformed) model id.
 */
export function transformModelForProvider(provider, model) {
  if (provider === "vercel") {
    const slashIndex = model.indexOf("/")
    if (slashIndex !== -1) {
      const subProvider = model.substring(0, slashIndex)
      const subModel = model.substring(slashIndex + 1)
      return `${subProvider}/${applyGatewayTransforms(subModel)}`
    }
    const subProvider = inferSubProvider(model)
    if (subProvider) {
      return `${subProvider}/${applyGatewayTransforms(model)}`
    }
    return model
  }
  if (provider === "github-copilot") {
    return claudeVersionDot(model)
      .replace(GEMINI_31_PRO_PREVIEW, "gemini-3.1-pro-preview")
      .replace(GEMINI_3_FLASH_PREVIEW, "gemini-3-flash-preview")
  }
  if (provider === "google") {
    return model
      .replace(GEMINI_31_PRO_PREVIEW, "gemini-3.1-pro-preview")
      .replace(GEMINI_3_FLASH_PREVIEW, "gemini-3-flash-preview")
  }
  if (provider === "anthropic") {
    return model
  }
  if (provider === "kimi-coding" || provider === "kimi-for-coding") {
    if (model === "kimi-k3") return "k3"
    if (model === "kimi-k3-256k") return "k3-256k"
  }
  return model
}

function connectedSetOf(connectedProviders) {
  return Array.isArray(connectedProviders)
    ? new Set(connectedProviders.map((provider) => String(provider).toLowerCase()))
    : null
}

function isReachable(entry, connectedSet) {
  if (!connectedSet) return true
  if (!Array.isArray(entry?.providers)) return false
  return entry.providers.some((provider) => connectedSet.has(String(provider).toLowerCase()))
}

function providerListsModel(providerModels, modelID) {
  const wanted = canonicalizeModelID(modelID)
  return providerModels.some((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id
    return typeof id === "string" && canonicalizeModelID(id) === wanted
  })
}

/**
 * Upstream 8e705a122: drop connected providers whose cached model list is known
 * and does not contain the model. A provider that is not connected, or has no
 * cached list, is kept, so a cold or partial cache never blocks a fallback.
 */
export function filterProvidersServingModel(args = {}) {
  const { providers, model, connectedSet, modelsByProvider } = args
  const transform = typeof args.transformModelForProvider === "function" ? args.transformModelForProvider : transformModelForProvider
  if (!Array.isArray(providers)) return []
  if (!connectedSet || !modelsByProvider) return providers
  return providers.filter((provider) => {
    if (!connectedSet.has(String(provider).toLowerCase())) return true
    const providerModels = modelsByProvider[provider]
    if (!Array.isArray(providerModels) || providerModels.length === 0) return true
    return providerListsModel(providerModels, transform(provider, model))
  })
}

/**
 * Select the provider for a fallback entry, mirroring V1
 * `selectFallbackProviderWithCache`: first connected provider in the entry's
 * preference order, else the connected preferred provider, else the entry's
 * first provider, else the preferred provider, else "opencode".
 */
export function selectFallbackProviderFromConnected(providers, preferredProviderID, connectedSet) {
  if (connectedSet && Array.isArray(providers)) {
    for (const provider of providers) {
      if (connectedSet.has(String(provider).toLowerCase())) {
        return provider
      }
    }
    if (preferredProviderID && connectedSet.has(String(preferredProviderID).toLowerCase())) {
      return preferredProviderID
    }
  }
  if (Array.isArray(providers) && providers.length > 0) {
    return providers[0]
  }
  return preferredProviderID || "opencode"
}

/**
 * Walk the fallback chain from `attemptCount` and return the first candidate
 * that is reachable and not a no-op, mirroring the handler's selection loop.
 *
 * - `connectedSet` null means "no connectivity information" (every entry is
 *   reachable), exactly like V1 when no connected-providers cache exists.
 * - A candidate is a no-op when it resolves to the same provider AND the same
 *   canonicalized model id as `currentModel`; it is skipped so the chain does
 *   not retry the model that just failed.
 * - The loop is bounded by `fallbackChain.length` (the retry budget) and there
 *   is NO backoff or sleep.
 *
 * Returns `{ found, attemptCount, fallback?, providerID?, modelID? }`; the
 * returned `attemptCount` is how far the walk advanced, which the caller stores
 * as the next attempt number.
 */
export function selectNextFallback({
  fallbackChain,
  attemptCount = 0,
  currentModel,
  connectedSet = null,
  modelsByProvider,
  transform = transformModelForProvider,
}) {
  if (!Array.isArray(fallbackChain)) {
    return { found: false, attemptCount }
  }
  let selectedAttemptCount = attemptCount
  let nextFallback
  let nextProviderID
  while (selectedAttemptCount < fallbackChain.length) {
    const candidate = fallbackChain[selectedAttemptCount]
    if (!candidate) break
    selectedAttemptCount++
    if (!isReachable(candidate, connectedSet)) continue
    // Upstream 8e705a122: a connected provider that provably does not serve the
    // model is dropped, so the entry advances instead of spawning a child that
    // dies with "Model not found".
    const servingProviders = filterProvidersServingModel({
      providers: candidate.providers,
      model: candidate.model,
      connectedSet,
      modelsByProvider,
      transformModelForProvider: transform,
    })
    if (!isReachable({ ...candidate, providers: servingProviders }, connectedSet)) continue
    const candidateProviderID = selectFallbackProviderFromConnected(
      servingProviders,
      currentModel?.providerID,
      connectedSet,
    )
    const candidateModelID = transform(candidateProviderID, candidate.model)
    const isNoOpFallback =
      !!currentModel &&
      String(candidateProviderID).toLowerCase() === String(currentModel.providerID).toLowerCase() &&
      canonicalizeModelID(candidateModelID) === canonicalizeModelID(currentModel.modelID)
    if (isNoOpFallback) continue
    nextFallback = candidate
    nextProviderID = candidateProviderID
    break
  }
  if (!nextFallback) {
    return { found: false, attemptCount: selectedAttemptCount }
  }
  return {
    found: true,
    attemptCount: selectedAttemptCount,
    fallback: nextFallback,
    providerID: nextProviderID,
    modelID: transform(nextProviderID, nextFallback.model),
  }
}

function retryBlockReason(fallbackChain, attemptCount) {
  if (!Array.isArray(fallbackChain) || fallbackChain.length === 0) {
    return "no-chain"
  }
  if (!hasMoreFallbacks(fallbackChain, attemptCount)) {
    return "exhausted"
  }
  return "not-retryable"
}

/**
 * Decide the single next action for a failed background task.
 *
 * Order mirrors V1: an "agent not found" error retries with `FALLBACK_AGENT`
 * unless the task already runs `FALLBACK_AGENT` (that would be a no-op). Then
 * the fallback gate runs: a retryable OR provider-exhaustion-eligible error, a
 * non-empty chain, and a remaining budget (`attemptCount < chain.length`). A
 * provider-exhaustion signal is eligible even when the error is not otherwise
 * retryable. The selection loop then skips unreachable and no-op candidates.
 *
 * Returns `{ action, reason, agent, nextModel }` where `action` is
 * "retry" | "fallback-agent" | "none". `nextModel.attemptCount` is the next
 * attempt number to store; there is no delay because V1 has no backoff here.
 */
export function decideBackgroundRetry({
  errorInfo,
  currentModel,
  currentAgent,
  attemptCount = 0,
  fallbackChain,
  connectedProviders,
  modelsByProvider,
  transform,
} = {}) {
  if (isAgentNotFoundError(errorInfo) && currentAgent !== FALLBACK_AGENT) {
    return {
      action: "fallback-agent",
      reason: "agent-not-found",
      agent: FALLBACK_AGENT,
      nextModel: null,
    }
  }

  const canUseProviderExhaustionFallback = isProviderExhaustionFallbackEligible(errorInfo)
  const canRetry =
    (shouldRetryError(errorInfo) || canUseProviderExhaustionFallback) &&
    Array.isArray(fallbackChain) &&
    fallbackChain.length > 0 &&
    hasMoreFallbacks(fallbackChain, attemptCount)

  if (!canRetry) {
    return {
      action: "none",
      reason: retryBlockReason(fallbackChain, attemptCount),
      agent: null,
      nextModel: null,
    }
  }

  const connectedSet = connectedSetOf(connectedProviders)
  const selection = selectNextFallback({
    fallbackChain,
    attemptCount,
    currentModel,
    connectedSet,
    modelsByProvider,
    ...(transform ? { transform } : {}),
  })
  if (!selection.found) {
    return {
      action: "none",
      reason: "no-eligible-fallback",
      agent: null,
      nextModel: null,
    }
  }

  return {
    action: "retry",
    reason: "retry",
    agent: null,
    nextModel: {
      providerID: selection.providerID,
      modelID: selection.modelID,
      model: selection.fallback.model,
      variant: selection.fallback.variant,
      attemptCount: selection.attemptCount,
    },
  }
}
