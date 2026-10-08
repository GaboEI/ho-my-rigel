/**
 * Upstream 5a9bb74a4: effective fallback-chain resolution for a native V2
 * session. An explicit user model (a category `models` chain or `model`, or an
 * agent `model`) suppresses the built-in canonical chain; only the user's
 * `fallback_models` remain. A configured `fallback_models` replaces the built-in
 * chain even when the model was not pinned, mirroring V1 `configuredFallbackChain`.
 * With no user override the built-in chain stays.
 *
 * Pure and dependency-injected so `rigel-v2-native-explicit-chain.test.mjs` can
 * pin the decision without booting the runtime.
 */

import { agentChain, categoryChain } from "./rigel-v2-native-model-chains.mjs"
import { normalizeUserChain } from "./rigel-v2-native-categories.mjs"

/** Canonical agent key: lowercase base id, display suffix (" - ...") stripped. */
export function normalizeAgentOverrideKey(agent) {
  const raw = String(agent ?? "").trim().toLocaleLowerCase()
  return raw ? raw.split(/\s+-\s+/)[0].trim() : ""
}

/** The user override for an agent, matched by canonical or raw (lowercased) id. */
export function agentOverrideFor(agentOverrides, agent) {
  const overrides = agentOverrides && typeof agentOverrides === "object" ? agentOverrides : {}
  const key = normalizeAgentOverrideKey(agent)
  if (!key) return undefined
  if (overrides[key]) return overrides[key]
  const direct = Object.keys(overrides).find((candidate) => candidate.toLocaleLowerCase() === key)
  return direct ? overrides[direct] : undefined
}

/** Whether a user category config pinned its own model (the explicit signal). */
export function categoryIsExplicit(userCategories, name) {
  const config = userCategories && typeof userCategories === "object" ? userCategories[name] : undefined
  return Boolean(
    (typeof config?.model === "string" && config.model.trim())
    || (Array.isArray(config?.models) && config.models.length > 0),
  )
}

/** The user `fallback_models` chain for a category, or undefined when absent. */
export function categoryFallbackChain(userCategories, name) {
  const config = userCategories && typeof userCategories === "object" ? userCategories[name] : undefined
  return normalizeUserChain(config?.fallback_models)
}

/**
 * Resolve the fallback chain a session walks.
 *
 * `descriptor` is the tracked category child (`{ name, explicit?, chain? }`)
 * when the session is a category delegation; a restored descriptor may carry
 * only `name`, so the explicit flag/chain are recomputed from `userCategories`.
 * Otherwise the session is an agent session and the agent's user override (if
 * any) decides. Returns an array (possibly empty when explicit with no
 * `fallback_models`, meaning "no fallback") or undefined when nothing applies.
 */
export function resolveEffectiveChain({ descriptor, agent, userCategories, agentOverrides } = {}) {
  if (descriptor && typeof descriptor === "object" && typeof descriptor.name === "string") {
    const name = descriptor.name
    const explicit = typeof descriptor.explicit === "boolean" ? descriptor.explicit : categoryIsExplicit(userCategories, name)
    const configured = Array.isArray(descriptor.chain) ? descriptor.chain : categoryFallbackChain(userCategories, name)
    if (configured) return configured
    return explicit ? [] : categoryChain(name)
  }
  const override = agentOverrideFor(agentOverrides, agent)
  if (override) {
    const configured = normalizeUserChain(override.fallback_models)
    if (configured) return configured
    if (typeof override.model === "string" && override.model) return []
  }
  return agentChain(agent)
}
