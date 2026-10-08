import { describe, expect, test } from "bun:test"
import {
  getNextFallback as v1GetNextFallback,
  hasMoreFallbacks as v1HasMoreFallbacks,
  isRetryableModelError as v1IsRetryableModelError,
  selectFallbackProviderWithCache as v1SelectFallbackProviderWithCache,
  shouldRetryError as v1ShouldRetryError,
} from "../../../packages/model-core/src/model-error-classifier.ts"
import { isProviderExhaustionFallbackEligible as v1IsProviderExhaustionFallbackEligible } from "../../../packages/model-core/src/provider-exhaustion-fallback-policy.ts"
import {
  classifyRuntimeFallbackError as v1ClassifyRuntimeFallbackError,
  isTerminalQuotaError as v1IsTerminalQuotaError,
} from "../../../packages/model-core/src/runtime-fallback-error-classifier.ts"
import { transformModelForProvider as v1TransformModelForProvider } from "../../../packages/model-core/src/provider-model-id-transform.ts"
import { FALLBACK_AGENT as v1FallbackAgent, isAgentNotFoundError as v1IsAgentNotFoundError } from "../../../packages/omo-opencode/src/features/background-agent/spawner/fallback-agent.ts"
import {
  classifyRuntimeFallbackError,
  isProviderExhaustionFallbackEligible,
  isRetryableModelError,
  isTerminalQuotaError,
  shouldRetryError,
} from "./rigel-v2-background-error.mjs"
import {
  FALLBACK_AGENT,
  canonicalizeModelID,
  decideBackgroundRetry,
  filterProvidersServingModel,
  getNextFallback,
  hasMoreFallbacks,
  isAgentNotFoundError,
  selectFallbackProviderFromConnected,
  selectNextFallback,
  transformModelForProvider,
} from "./rigel-v2-background-retry.mjs"

// The native V2 runtime cannot import `packages/` TypeScript, so the retry
// policy is a plain-JS port of the real owners:
//   packages/omo-opencode/src/features/background-agent/fallback-retry-handler.ts
//   packages/model-core/src/model-error-classifier.ts
//   packages/model-core/src/provider-exhaustion-fallback-policy.ts
//   packages/model-core/src/provider-model-id-transform.ts
//   packages/omo-opencode/src/features/background-agent/spawner/fallback-agent.ts
// The parity blocks import the real TS owners and pin agreement, so upstream
// drift in the classifier, the transform, or the fallback budget fails the suite.

const ANTHROPIC_CURRENT = { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
const CHAIN = [
  { model: "claude-opus-4-7", providers: ["anthropic"] },
  { model: "gemini-3.1-pro", providers: ["google"] },
]

// Plain `{ name, message, statusCode }` errorInfo objects, exactly the shape V1
// `tryFallbackRetry` receives. Covers retryable names, non-retryable names,
// message patterns, status codes, terminal quota, quota exhaustion, and benign
// text so a branch-order or pattern drift fails parity.
const ERROR_CORPUS = [
  { name: "ProviderModelNotFoundError" },
  { name: "RateLimitError" },
  { name: "ModelUnavailableError" },
  { name: "ProviderConnectionError" },
  { name: "AuthenticationError" },
  { name: "MessageAbortedError" },
  { name: "PermissionDeniedError" },
  { name: "ContextLengthError" },
  { name: "TimeoutError" },
  { name: "ValidationError" },
  { name: "SyntaxError" },
  { name: "UserError" },
  { name: "QuotaExceeded" },
  { name: "InsufficientQuota" },
  { name: "UnknownError", message: "model not found" },
  { message: "rate limit exceeded" },
  { message: "usage_limit_reached" },
  { message: "usage limit has been reached" },
  { message: "quota exceeded" },
  { message: "all credentials for model x cooling down" },
  { message: "exhausted your capacity" },
  { message: "model not found" },
  { message: "service unavailable" },
  { message: "insufficient credits" },
  { message: "too many requests" },
  { message: "overloaded" },
  { message: "bad gateway" },
  { message: "unknown provider" },
  { message: "model_not_supported" },
  { message: "connection error" },
  { message: "network error" },
  { message: "timeout" },
  { message: "internal_server_error" },
  { message: "free usage" },
  { message: "temporarily unavailable" },
  { message: "try again" },
  { message: "selected provider is forbidden" },
  { message: "server_error while processing" },
  { message: "upstream request failed" },
  { message: "terminal quota exhausted" },
  { message: "hard billing limit reached" },
  { message: "non-terminal quota" },
  { message: "api key is missing from environment variable" },
  { message: "api key must be a string" },
  { message: "provider is cooling down, retrying in 5s with rate limit" },
  { message: "unrelated benign text" },
  { statusCode: 429 },
  { statusCode: 503 },
  { statusCode: 529 },
  { statusCode: 500 },
  { name: "MessageAbortedError", message: "quota exceeded" },
  {},
]

describe("#given the real V1 error classifiers", () => {
  describe("#when the whole error corpus is classified", () => {
    test("#then the V2 taxonomy agrees on retryable, terminal quota, and provider exhaustion", () => {
      // given / when / then
      for (const errorInfo of ERROR_CORPUS) {
        expect(isRetryableModelError(errorInfo)).toBe(v1IsRetryableModelError(errorInfo))
        expect(shouldRetryError(errorInfo)).toBe(v1ShouldRetryError(errorInfo))
        expect(isProviderExhaustionFallbackEligible(errorInfo)).toBe(
          v1IsProviderExhaustionFallbackEligible(errorInfo),
        )
        expect(isTerminalQuotaError(errorInfo)).toBe(v1IsTerminalQuotaError(errorInfo))
        expect(classifyRuntimeFallbackError(errorInfo)).toBe(v1ClassifyRuntimeFallbackError(errorInfo))
      }
    })
  })

  describe("#when the transform is applied", () => {
    test("#then the V2 transform agrees with V1 across providers", () => {
      // given
      const samples = [
        ["vercel", "claude-sonnet-4-6"],
        ["vercel", "anthropic/claude-sonnet-4-6"],
        ["vercel", "gpt-5-6-sol"],
        ["github-copilot", "claude-sonnet-4-6"],
        ["github-copilot", "gemini-3-flash"],
        ["google", "gemini-3.1-pro"],
        ["anthropic", "claude-sonnet-4-6"],
        ["kimi-coding", "kimi-k3"],
        ["kimi-for-coding", "kimi-k3-256k"],
        ["opencode", "anything"],
      ]

      // when / then
      for (const [provider, model] of samples) {
        expect(transformModelForProvider(provider, model)).toBe(
          v1TransformModelForProvider(provider, model),
        )
      }
    })
  })

  describe("#when the fallback budget helpers are used", () => {
    test("#then hasMoreFallbacks and getNextFallback agree with V1", () => {
      // given
      const chain = [{ model: "a" }, { model: "b" }, { model: "c" }]

      // when / then
      for (let attempt = 0; attempt <= chain.length + 1; attempt += 1) {
        expect(hasMoreFallbacks(chain, attempt)).toBe(v1HasMoreFallbacks(chain, attempt))
        expect(getNextFallback(chain, attempt)).toBe(v1GetNextFallback(chain, attempt))
      }
    })
  })

  describe("#when a provider is selected from connectivity", () => {
    test("#then the V2 helper agrees with V1 selectFallbackProviderWithCache", () => {
      // given
      const cache = (connected) => ({ readConnectedProvidersCache: () => connected })
      const cases = [
        { providers: ["anthropic", "google"], connected: ["google"], preferred: undefined },
        { providers: ["anthropic", "google"], connected: ["anthropic"], preferred: "google" },
        { providers: ["anthropic"], connected: ["google"], preferred: "google" },
        { providers: ["anthropic"], connected: null, preferred: "google" },
        { providers: [], connected: null, preferred: undefined },
        { providers: ["anthropic"], connected: [], preferred: undefined },
      ]

      // when / then
      for (const { providers, connected, preferred } of cases) {
        const connectedSet = connected === null ? null : new Set(connected.map((p) => p.toLowerCase()))
        expect(selectFallbackProviderFromConnected(providers, preferred, connectedSet)).toBe(
          v1SelectFallbackProviderWithCache(providers, cache(connected), preferred),
        )
      }
    })
  })

  describe("#when agent-not-found is detected", () => {
    test("#then the V2 detector agrees with V1 and the fallback agent matches", () => {
      // given
      const cases = [
        { message: "Agent not found: ghost" },
        "Agent not found: ghost",
        new Error("Agent not found"),
        { message: "agent.name is undefined" },
        { message: "unrelated" },
        {},
      ]

      // when / then
      for (const sample of cases) {
        expect(isAgentNotFoundError(sample)).toBe(v1IsAgentNotFoundError(sample))
      }
      expect(FALLBACK_AGENT).toBe(v1FallbackAgent)
    })
  })
})

describe("#given a failed background task", () => {
  describe("#when the error is retryable by name", () => {
    test("#then the first eligible chain entry is selected", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "ProviderModelNotFoundError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then
      expect(decision.action).toBe("retry")
      expect(decision.nextModel).toMatchObject({
        providerID: "anthropic",
        modelID: "claude-opus-4-7",
        model: "claude-opus-4-7",
        attemptCount: 1,
      })
    })
  })

  describe("#when the error is retryable only by message", () => {
    test("#then the fallback still advances", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { message: "provider is overloaded" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then
      expect(decision.action).toBe("retry")
      expect(decision.nextModel.providerID).toBe("anthropic")
    })
  })

  describe("#when the error carries only a retryable status code", () => {
    test("#then the fallback still advances", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { statusCode: 429 },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then
      expect(decision.action).toBe("retry")
    })
  })

  describe("#when the error is provider exhaustion", () => {
    test("#then it is eligible even without a retryable name", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "SomeError", message: "quota exceeded" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then
      expect(isProviderExhaustionFallbackEligible({ name: "SomeError", message: "quota exceeded" })).toBe(true)
      expect(decision.action).toBe("retry")
    })
  })

  describe("#when the error is a terminal quota", () => {
    test("#then no retry is attempted", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { message: "terminal quota exhausted" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then
      expect(decision.action).toBe("none")
      expect(decision.reason).toBe("not-retryable")
    })
  })

  describe("#when the error is non-retryable", () => {
    test("#then no retry is attempted", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "MessageAbortedError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then
      expect(decision.action).toBe("none")
      expect(decision.reason).toBe("not-retryable")
    })
  })

  describe("#when there is no fallback chain", () => {
    test("#then the reason is no-chain", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: undefined,
      })

      // then
      expect(decision).toEqual({ action: "none", reason: "no-chain", agent: null, nextModel: null })
    })

    test("#then an empty chain is also no-chain", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: [],
      })

      // then
      expect(decision.reason).toBe("no-chain")
    })
  })

  describe("#when the retry budget is spent", () => {
    test("#then the reason is exhausted", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: CHAIN.length,
        fallbackChain: CHAIN,
      })

      // then
      expect(decision).toEqual({ action: "none", reason: "exhausted", agent: null, nextModel: null })
    })
  })

  describe("#when the fallback would be a no-op", () => {
    test("#then the same provider and model are skipped for the next distinct entry", () => {
      // given
      const chain = [
        { model: "claude-sonnet-4-6", providers: ["anthropic"] },
        { model: "claude-opus-4-7", providers: ["anthropic"] },
      ]

      // when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: chain,
      })

      // then: the first entry is the current model, so the second is used
      expect(decision.action).toBe("retry")
      expect(decision.nextModel.modelID).toBe("claude-opus-4-7")
      expect(decision.nextModel.attemptCount).toBe(2)
    })

    test("#then a chain made only of no-ops yields no-eligible-fallback", () => {
      // given
      const chain = [{ model: "claude-sonnet-4-6", providers: ["anthropic"] }]

      // when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: chain,
      })

      // then
      expect(decision).toEqual({ action: "none", reason: "no-eligible-fallback", agent: null, nextModel: null })
    })

    test("#then the transform is what makes a dotted-vs-dashed id a no-op", () => {
      // given: current model is the already-transformed vercel id
      const currentModel = { providerID: "vercel", modelID: "anthropic/claude-sonnet-4.6" }
      const chain = [{ model: "claude-sonnet-4-6", providers: ["vercel"] }]

      // when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel,
        attemptCount: 0,
        fallbackChain: chain,
      })

      // then: transform("vercel","claude-sonnet-4-6") resolves to the current id
      expect(transformModelForProvider("vercel", "claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6")
      expect(decision.reason).toBe("no-eligible-fallback")
    })
  })

  describe("#when a candidate provider is disconnected", () => {
    test("#then it is skipped and the next connected entry is used", () => {
      // given
      const chain = [
        { model: "claude-opus-4-7", providers: ["anthropic"] },
        { model: "gemini-3.1-pro", providers: ["google"] },
      ]

      // when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: chain,
        connectedProviders: ["google"],
      })

      // then
      expect(decision.action).toBe("retry")
      expect(decision.nextModel.providerID).toBe("google")
      expect(decision.nextModel.attemptCount).toBe(2)
    })

    test("#then a chain with no reachable entry yields no-eligible-fallback", () => {
      // given
      const chain = [{ model: "claude-opus-4-7", providers: ["anthropic"] }]

      // when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: chain,
        connectedProviders: ["google"],
      })

      // then
      expect(decision).toEqual({ action: "none", reason: "no-eligible-fallback", agent: null, nextModel: null })
    })
  })

  describe("#when the fallback entry declares a variant", () => {
    test("#then the variant is carried into the next model", () => {
      // given
      const chain = [{ model: "claude-opus-4-7", providers: ["anthropic"], variant: "high" }]

      // when
      const decision = decideBackgroundRetry({
        errorInfo: { name: "RateLimitError" },
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: chain,
      })

      // then
      expect(decision.nextModel.variant).toBe("high")
    })
  })
})

describe("#given an agent-not-found error", () => {
  describe("#when the task agent is not already the fallback agent", () => {
    test("#then the decision is fallback-agent to general", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { message: "Agent not found: ghost" },
        currentAgent: "ghost",
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then
      expect(decision).toEqual({
        action: "fallback-agent",
        reason: "agent-not-found",
        agent: FALLBACK_AGENT,
        nextModel: null,
      })
    })
  })

  describe("#when the task already runs the fallback agent", () => {
    test("#then it does not loop on itself and falls through to the model fallback", () => {
      // given / when
      const decision = decideBackgroundRetry({
        errorInfo: { message: "Agent not found: ghost" },
        currentAgent: FALLBACK_AGENT,
        currentModel: ANTHROPIC_CURRENT,
        attemptCount: 0,
        fallbackChain: CHAIN,
      })

      // then: "not found" is a retryable message, so the model chain advances
      expect(decision.action).toBe("retry")
      expect(decision.agent).toBeNull()
    })
  })
})

describe("#given selectNextFallback directly", () => {
  describe("#when the chain is bounded by its length", () => {
    test("#then the walk never exceeds the budget and reports where it stopped", () => {
      // given: every entry is a no-op for the current model
      const chain = [
        { model: "claude-sonnet-4-6", providers: ["anthropic"] },
        { model: "claude-sonnet-4-6", providers: ["anthropic"] },
      ]

      // when
      const selection = selectNextFallback({
        fallbackChain: chain,
        attemptCount: 0,
        currentModel: ANTHROPIC_CURRENT,
      })

      // then: examined both, found nothing, stopped at the chain length
      expect(selection.found).toBe(false)
      expect(selection.attemptCount).toBe(chain.length)
    })
  })

  describe("#when no connectivity information is available", () => {
    test("#then every entry is treated as reachable", () => {
      // given / when
      const selection = selectNextFallback({
        fallbackChain: CHAIN,
        attemptCount: 0,
        currentModel: ANTHROPIC_CURRENT,
        connectedSet: null,
      })

      // then
      expect(selection.found).toBe(true)
      expect(selection.providerID).toBe("anthropic")
    })
  })

  describe("#when canonicalizeModelID compares ids", () => {
    test("#then dots and dashes are equivalent and case is ignored", () => {
      // given / when / then
      expect(canonicalizeModelID("Claude-Sonnet-4.6")).toBe(canonicalizeModelID("claude-sonnet-4-6"))
    })
  })
})

// Upstream 8e705a122: skip fallback entries no connected provider serves.
describe("#when a connected provider does not serve the fallback model", () => {
  test("#then the entry is skipped and a later served provider is selected", () => {
    const decision = decideBackgroundRetry({
      errorInfo: { statusCode: 429 },
      currentModel: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      attemptCount: 0,
      fallbackChain: [
        { providers: ["openai"], model: "gpt-6-astra" },
        { providers: ["deepseek"], model: "deepseek-flash" },
      ],
      connectedProviders: ["openai", "deepseek"],
      modelsByProvider: { openai: ["gpt-6-luna-fast"], deepseek: ["deepseek-flash"] },
    })
    expect(decision.action).toBe("retry")
    expect(decision.nextModel.providerID).toBe("deepseek")
    expect(decision.nextModel.modelID).toBe("deepseek-flash")
  })

  test("#then no retry happens when no connected provider serves any entry", () => {
    const decision = decideBackgroundRetry({
      errorInfo: { statusCode: 429 },
      currentModel: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      fallbackChain: [{ providers: ["openai"], model: "gpt-6-astra" }],
      connectedProviders: ["openai"],
      modelsByProvider: { openai: ["gpt-6-luna-fast"] },
    })
    expect(decision.action).toBe("none")
    expect(decision.reason).toBe("no-eligible-fallback")
  })

  test("#then a provider without a cached model list is kept (a cold cache never blocks)", () => {
    const decision = decideBackgroundRetry({
      errorInfo: { statusCode: 429 },
      currentModel: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      fallbackChain: [{ providers: ["openai"], model: "gpt-6-astra" }],
      connectedProviders: ["openai"],
      modelsByProvider: {},
    })
    expect(decision.action).toBe("retry")
    expect(decision.nextModel.providerID).toBe("openai")
  })

  test("#then without any provider model cache the previous behavior is unchanged", () => {
    const decision = decideBackgroundRetry({
      errorInfo: { statusCode: 429 },
      currentModel: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      fallbackChain: [{ providers: ["openai"], model: "gpt-6-astra" }],
      connectedProviders: ["openai"],
    })
    expect(decision.action).toBe("retry")
    expect(decision.nextModel.providerID).toBe("openai")
  })
})

describe("#when filterProvidersServingModel is applied directly", () => {
  test("#then it drops only connected providers whose loaded list lacks the model", () => {
    const kept = filterProvidersServingModel({
      providers: ["openai", "deepseek", "anthropic"],
      model: "gpt-6-astra",
      connectedSet: new Set(["openai", "deepseek"]),
      modelsByProvider: { openai: ["gpt-6-luna-fast"], deepseek: ["gpt-6-astra"] },
      transformModelForProvider: (provider, model) => model,
    })
    // A non-connected provider is kept (V1 keeps it; isReachable then decides).
    expect(kept).toEqual(["deepseek", "anthropic"])
  })
})
