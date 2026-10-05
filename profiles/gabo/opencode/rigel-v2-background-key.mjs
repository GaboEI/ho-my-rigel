/**
 * Background-agent admission key for Oh My Rigel's native OpenCode V2 runtime.
 *
 * Plain-JS port of the matching OmO revision:
 *   packages/omo-opencode/src/features/background-agent/concurrency.ts:25-53
 *     getConcurrencyLimit(model): modelConcurrency[model] -> providerConcurrency[provider] -> defaultConcurrency -> 5
 *     getConcurrencyKey(model):   modelConcurrency[model] ? model : providerConcurrency[provider] ? provider : model
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so the
 * priority lives here as a pure function. `rigel-v2-background-key.test.mjs`
 * imports the real TS owner and pins parity, so upstream drift fails the suite.
 *
 * OQ-4 decision (see .omo/evidence/20261005-task-20/oq4-decision.md): the
 * `subagent_type` route resolves its model only AFTER session creation
 * (`rigel-v2-native.mjs:618` exposes `category?.model` pre-spawn; the
 * `onChildSession` callback at 620-624 supplies the child session, not a model),
 * so a per-model key is structurally unavailable at admission. The chosen
 * resolution is a tested pure key derivation: admission uses the pre-spawn
 * `category?.model` when present, and the manager re-keys on the resolved model
 * once `onChildSession` supplies it. This module owns the derivation both routes
 * share, so the key is stable regardless of which route produced the model.
 *
 * Pure module: no imports, no runtime dependencies, no I/O.
 */

/**
 * Resolve the concurrency limit for a model, mirroring V1
 * `ConcurrencyManager.getConcurrencyLimit` exactly:
 *   1. `modelConcurrency[model]` when defined (0 means Infinity)
 *   2. `providerConcurrency[provider]` when defined (0 means Infinity)
 *   3. `defaultConcurrency` when defined (0 means Infinity)
 *   4. 5
 *
 * `provider` is the segment before the first `/`; a model with no `/` is its
 * own provider (V1 `model.split('/')[0]`).
 */
export function resolveAdmissionLimit(model, config) {
  const modelKey = normalizeModel(model)
  const modelLimit = config?.modelConcurrency?.[modelKey]
  if (modelLimit !== undefined) {
    return modelLimit === 0 ? Infinity : modelLimit
  }
  const provider = providerOf(modelKey)
  const providerLimit = config?.providerConcurrency?.[provider]
  if (providerLimit !== undefined) {
    return providerLimit === 0 ? Infinity : providerLimit
  }
  const defaultLimit = config?.defaultConcurrency
  if (defaultLimit !== undefined) {
    return defaultLimit === 0 ? Infinity : defaultLimit
  }
  return 5
}

/**
 * Resolve the concurrency key for a model, mirroring V1
 * `ConcurrencyManager.getConcurrencyKey` exactly:
 *   - exact model when `modelConcurrency[model]` is configured
 *   - provider when `providerConcurrency[provider]` is configured
 *   - exact model otherwise
 *
 * The key is what the FIFO queue and the slot counter are bucketed by, so two
 * models that share a provider bucket share one limit.
 */
export function resolveAdmissionKey(model, config) {
  const modelKey = normalizeModel(model)
  if (config?.modelConcurrency?.[modelKey] !== undefined) {
    return modelKey
  }
  const provider = providerOf(modelKey)
  if (provider && config?.providerConcurrency?.[provider] !== undefined) {
    return provider
  }
  return modelKey
}

/**
 * The provider segment of a model id: everything before the first `/`.
 * A model with no `/` is its own provider. Empty/absent input yields "".
 */
export function providerOf(model) {
  const modelKey = normalizeModel(model)
  const slash = modelKey.indexOf("/")
  return slash === -1 ? modelKey : modelKey.slice(0, slash)
}

/**
 * Normalize a model id to a stable string. Non-string input (undefined, null,
 * a number) becomes "" so the derivation never throws on a missing model; the
 * caller decides whether "" is an acceptable key.
 */
export function normalizeModel(model) {
  return typeof model === "string" ? model : ""
}
