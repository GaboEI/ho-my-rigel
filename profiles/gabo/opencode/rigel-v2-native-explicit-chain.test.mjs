import { test, expect } from "bun:test"
import { agentOverrideFor, categoryIsExplicit, resolveEffectiveChain } from "./rigel-v2-native-explicit-chain.mjs"
import { agentChain, categoryChain } from "./rigel-v2-native-model-chains.mjs"

// Upstream 5a9bb74a4: an explicit user model suppresses the built-in chain.

test("an explicit category with no fallback_models resolves to an empty (no-fallback) chain", () => {
  const userCategories = { quick: { model: "openai/gpt-6-luna-fast" } }
  const chain = resolveEffectiveChain({ descriptor: { name: "quick", explicit: true }, agent: "Sisyphus-Junior", userCategories })
  expect(chain).toEqual([])
})

test("a non-explicit category keeps the built-in chain", () => {
  const chain = resolveEffectiveChain({ descriptor: { name: "quick", explicit: false }, agent: "Sisyphus-Junior", userCategories: {} })
  expect(chain).toEqual(categoryChain("quick"))
})

test("an explicit category uses only the user fallback_models chain", () => {
  const userCategories = {
    quick: { model: "openai/gpt-6-luna-fast", fallback_models: ["openai/gpt-6-luna-fast(low)", "deepseek/deepseek-flash"] },
  }
  const chain = resolveEffectiveChain({ descriptor: { name: "quick", explicit: true }, agent: "Sisyphus-Junior", userCategories })
  expect(chain).toEqual([
    { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-flash" },
  ])
})

test("a restored category descriptor recomputes explicit from the live user categories", () => {
  const userCategories = { quick: { model: "openai/gpt-6-luna-fast" } }
  expect(resolveEffectiveChain({ descriptor: { name: "quick" }, agent: "Sisyphus-Junior", userCategories })).toEqual([])
})

test("an explicit agent model suppresses the built-in chain", () => {
  const agentOverrides = { sisyphus: { model: "anthropic/claude-opus-5-5", variant: "max" } }
  expect(resolveEffectiveChain({ agent: "Sisyphus - ultraworker", agentOverrides })).toEqual([])
})

test("an agent fallback_models chain replaces the built-in chain even without a pinned model", () => {
  const agentOverrides = { oracle: { fallback_models: ["openai/gpt-6-astra(xhigh)"] } }
  expect(resolveEffectiveChain({ agent: "oracle", agentOverrides })).toEqual([
    { providers: ["openai"], model: "gpt-6-astra", variant: "xhigh" },
  ])
})

test("an agent with no override keeps the built-in chain", () => {
  expect(resolveEffectiveChain({ agent: "oracle", agentOverrides: {} })).toEqual(agentChain("oracle"))
})

test("isolation: an explicit session's chain does not affect a sibling session", () => {
  const userCategories = { quick: { model: "openai/gpt-6-luna-fast" }, writing: {} }
  const explicit = resolveEffectiveChain({ descriptor: { name: "quick", explicit: true }, agent: "Sisyphus-Junior", userCategories })
  const builtin = resolveEffectiveChain({ descriptor: { name: "writing", explicit: false }, agent: "Sisyphus-Junior", userCategories })
  expect(explicit).toEqual([])
  expect(builtin).toEqual(categoryChain("writing"))
})

test("agentOverrideFor matches a display-cased agent name to its override id", () => {
  expect(agentOverrideFor({ sisyphus: { model: "x/y" } }, "Sisyphus - ultraworker")).toEqual({ model: "x/y" })
})

test("categoryIsExplicit only fires on a user model or models chain", () => {
  expect(categoryIsExplicit({ quick: { description: "no model" } }, "quick")).toBe(false)
  expect(categoryIsExplicit({ quick: { models: ["openai/gpt-6-luna-fast"] } }, "quick")).toBe(true)
})
