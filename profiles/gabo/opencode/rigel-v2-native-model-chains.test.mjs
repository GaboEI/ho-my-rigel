import { expect, test } from "bun:test"
import { AGENT_MODEL_REQUIREMENTS } from "../../../packages/model-core/src/agent-model-requirements.ts"
import { CATEGORY_MODEL_REQUIREMENTS } from "../../../packages/model-core/src/category-model-requirements.ts"
import manifest from "./rigel-v2-category-manifest.mjs"
import {
  AGENT_MODEL_CHAINS,
  CATEGORY_MODEL_CHAINS,
  agentChain,
  categoryChain,
  isModelAvailable,
  resolveFallbackModel,
} from "./rigel-v2-native-model-chains.mjs"

// The native runtime cannot import `packages/` TypeScript, so the chains are a
// data-only port. These tests import the real TS owners and pin deep equality:
// a model-core chain edit that is not mirrored here fails the suite.
test("agent chains are a faithful port of model-core (11 agents)", () => {
  expect(Object.keys(AGENT_MODEL_CHAINS)).toHaveLength(11)
  expect(Object.keys(AGENT_MODEL_CHAINS).sort()).toEqual(Object.keys(AGENT_MODEL_REQUIREMENTS).sort())
  for (const [name, chain] of Object.entries(AGENT_MODEL_CHAINS)) {
    expect(chain).toEqual(AGENT_MODEL_REQUIREMENTS[name].fallbackChain)
  }
})

test("category chains are a faithful port of model-core (9 categories)", () => {
  expect(Object.keys(CATEGORY_MODEL_CHAINS)).toHaveLength(9)
  expect(Object.keys(CATEGORY_MODEL_CHAINS).sort()).toEqual(Object.keys(CATEGORY_MODEL_REQUIREMENTS).sort())
  for (const [name, chain] of Object.entries(CATEGORY_MODEL_CHAINS)) {
    expect(chain).toEqual(CATEGORY_MODEL_REQUIREMENTS[name].fallbackChain)
  }
})

// The category manifest freezes the primary lane; the canonical chain is its
// source of truth. This is the contract that caught the `deep-high` xhigh/high
// drift, so it must compare the two real artifacts rather than restate them.
test("category manifest primary lane agrees with the canonical chain head", () => {
  for (const [name, config] of Object.entries(manifest.categories)) {
    const chain = CATEGORY_MODEL_CHAINS[name]
    expect(chain).toBeDefined()
    const [providerID, id] = String(config.model).split("/")
    const head = chain[0]
    expect(head.model).toBe(id)
    expect(head.variant ?? undefined).toBe(config.variant)
    expect(head.providers).toContain(providerID)
  }
})

test("resolveFallbackModel falls to the next rung when the primary is absent", () => {
  const chain = AGENT_MODEL_CHAINS.explore
  const available = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "missing-model" }))
    .toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("resolveFallbackModel skips a model marked failed even when it is available", () => {
  const chain = AGENT_MODEL_CHAINS.explore
  const available = [
    { providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", enabled: true },
    { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
  ]
  const resolved = resolveFallbackModel({
    chain,
    availableModels: available,
    currentModel: "kimi-for-coding-highspeed",
    failedModels: new Set(["kimi-for-coding-highspeed"]),
  })
  expect(resolved).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("resolveFallbackModel never cross-routes a rung to an undeclared provider", () => {
  const chain = [{ providers: ["anthropic"], model: "claude-opus-5-5", variant: "max" }]
  const available = [{ providerID: "openai", id: "claude-opus-5-5", enabled: true }]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "missing" })).toBeUndefined()
})

test("resolveFallbackModel keeps an available, non-failed current model", () => {
  const chain = AGENT_MODEL_CHAINS.explore
  const available = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "openai/gpt-6-luna-fast" }))
    .toEqual({ providerID: "openai", id: "gpt-6-luna-fast" })
})

test("isModelAvailable is provider-scoped and honours the enabled flag", () => {
  const available = [{ providerID: "openai", id: "claude-opus-5-5", enabled: true }]
  expect(isModelAvailable("anthropic/claude-opus-5-5", available)).toBe(false)
  expect(isModelAvailable("claude-opus-5-5", available)).toBe(true)
  expect(isModelAvailable("openai/claude-opus-5-5", [{ providerID: "openai", id: "claude-opus-5-5", enabled: false }])).toBe(false)
})

test("resolveFallbackModel with sameProviderAs only returns a matching-provider rung", () => {
  const chain = [
    { providers: ["openai"], model: "a" },
    { providers: ["kimi-for-coding"], model: "b" },
  ]
  const available = [
    { providerID: "openai", id: "a", enabled: true },
    { providerID: "kimi-for-coding", id: "b", enabled: true },
  ]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "missing", sameProviderAs: "openai" }))
    .toEqual({ providerID: "openai", id: "a" })
})

test("resolveFallbackModel with sameProviderAs returns undefined when no rung is on that provider", () => {
  const chain = [{ providers: ["kimi-for-coding"], model: "b" }]
  const available = [{ providerID: "kimi-for-coding", id: "b", enabled: true }]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "missing", sameProviderAs: "openai" }))
    .toBeUndefined()
})

test("resolveFallbackModel intersects the rung's providers with sameProviderAs before matching", () => {
  const chain = [{ providers: ["kimi-for-coding", "openai"], model: "a" }]
  const available = [
    { providerID: "kimi-for-coding", id: "a", enabled: true },
    { providerID: "openai", id: "a", enabled: true },
  ]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "missing", sameProviderAs: "openai" }))
    .toEqual({ providerID: "openai", id: "a" })
})

test("resolveFallbackModel honours a disabled rung under sameProviderAs", () => {
  const chain = [{ providers: ["openai"], model: "a" }]
  const available = [{ providerID: "openai", id: "a", enabled: false }]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "missing", sameProviderAs: "openai" }))
    .toBeUndefined()
})

test("resolveFallbackModel skips a failed rung and stays on the same provider", () => {
  const chain = [
    { providers: ["openai"], model: "a" },
    { providers: ["openai"], model: "c" },
  ]
  const available = [
    { providerID: "openai", id: "a", enabled: true },
    { providerID: "openai", id: "c", enabled: true },
  ]
  expect(resolveFallbackModel({
    chain,
    availableModels: available,
    currentModel: "missing",
    failedModels: new Set(["a"]),
    sameProviderAs: "openai",
  })).toEqual({ providerID: "openai", id: "c" })
})

test("resolveFallbackModel provider-scopes a bare current id under sameProviderAs", () => {
  const available = [
    { providerID: "openai", id: "shared-model", enabled: true },
    { providerID: "kimi-for-coding", id: "shared-model", enabled: true },
  ]
  // Served by both providers, the active provider wins and the bare ref is kept,
  // so the hook sees no cross rewrite.
  expect(resolveFallbackModel({ chain: [], availableModels: available, currentModel: "shared-model", sameProviderAs: "openai" }))
    .toEqual({ id: "shared-model" })
  const otherProviderOnly = [{ providerID: "kimi-for-coding", id: "shared-model", enabled: true }]
  expect(resolveFallbackModel({ chain: [], availableModels: otherProviderOnly, currentModel: "shared-model", sameProviderAs: "openai" }))
    .toBeUndefined()
})

test("resolveFallbackModel without sameProviderAs walks the full chain across providers", () => {
  // The pre-selection boundaries (proactive agent.transform and reactive
  // switchModel) omit sameProviderAs, so the walk must cross providers when
  // the first reachable rung lives on another one.
  const chain = [
    { providers: ["kimi-for-coding"], model: "kimi-for-coding-highspeed", variant: "off" },
    { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
  ]
  const available = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]
  expect(resolveFallbackModel({ chain, availableModels: available, currentModel: "missing" }))
    .toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("agentChain normalizes V2 display names to canonical chain keys", () => {
  expect(agentChain("Sisyphus - ultraworker")).toBe(AGENT_MODEL_CHAINS.sisyphus)
  expect(agentChain("Sisyphus-Junior")).toBe(AGENT_MODEL_CHAINS["sisyphus-junior"])
  expect(agentChain("multimodal-looker")).toBe(AGENT_MODEL_CHAINS["multimodal-looker"])
  expect(agentChain("not-an-agent")).toBeUndefined()
})

test("categoryChain resolves canonical categories only", () => {
  expect(categoryChain("deep-high")).toBe(CATEGORY_MODEL_CHAINS["deep-high"])
  expect(categoryChain("QUICK")).toBe(CATEGORY_MODEL_CHAINS.quick)
  expect(categoryChain("not-a-category")).toBeUndefined()
})
