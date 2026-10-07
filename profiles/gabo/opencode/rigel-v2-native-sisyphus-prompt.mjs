/**
 * Sisyphus runtime prompt reconciliation for the native V2 runtime.
 *
 * V1 baked the Sisyphus body for the *configured* model at registration and
 * rebuilt it per request inside `experimental.chat.system.transform` whenever the
 * runtime (TUI/auto-selected) model differed from the configured one, swapping
 * the whole body rather than patching one line (issues #5297/#5316/#6966). V2
 * exposes the runtime model at the `context` hook and lets the hook mutate
 * `event.system`, so the same contract is adapted here.
 *
 * The generator materializes the Sisyphus body for every model the runtime can
 * deterministically resolve for that agent (the exact reachable set: the agent's
 * fallback chain plus the manifest model). This module swaps the baked body for
 * the runtime model's body, caching per model, so no prompt rebuild happens per
 * request. A model outside the baked set is reported observably instead of being
 * silently left stale.
 *
 * The model key is the bare model name (the last `/` segment): the V1 factory
 * strips the provider before selecting the family and the baked body is
 * provider-independent (proven by experiment), while the exact model name is
 * embedded in the body, so the exact name — not the family — is the faithful key.
 */

export const SISYPHUS_AGENT_ID = "Sisyphus - ultraworker"
export const SISYPHUS_PROMPT_RECEIPT = "sisyphus-prompt-reconciled.json"

/** V1 `extractModelName`: the last `/` segment makes the key provider-independent. */
export function extractModelName(model) {
  const raw = String(model ?? "").trim()
  if (!raw) return ""
  const slash = raw.lastIndexOf("/")
  return slash >= 0 ? raw.slice(slash + 1) : raw
}

/**
 * V2 surfaces display-cased agent names such as `Sisyphus - ultraworker`; the
 * canonical base is the identifier before the ` - ` display suffix (mirrors the
 * runtime's `normalizeAgentName`). `Sisyphus-Junior` stays distinct.
 */
export function isSisyphusAgent(agent) {
  if (typeof agent !== "string" || !agent.trim()) return true
  const base = agent.trim().toLocaleLowerCase().split(/\s+-\s+/)[0].trim()
  return base === "sisyphus"
}

/**
 * Explicit GPT prompt-identity variants the Sisyphus body distinguishes. The gpt
 * family shares one body skeleton but the embedded identity line differs, so each
 * identity is baked explicitly. This is the runtime-facing mirror of
 * `packages/omo-opencode/src/agents/gpt-prompt-identity.ts` (pinned by a parity
 * test); `gpt-family` has no representative and is intentionally absent.
 */
export const SISYPHUS_PROMPT_IDENTITY_MODELS = ["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"]

// Mirrors upstream isReasoningLevelOrAuto (REASONING_LEVELS + auto): `off` is a
// valid level and `none` is not (it is an input alias that normalizeReasoning maps
// to `off`). Kept in lockstep so an explicit `:off` selects the bucket and a
// bogus `:none` does not.
const REASONING_VARIANTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"])

/** Split a lowercased bare selector into `{ name, variant }`. */
function splitSelectorVariant(selector) {
  const trimmed = selector.trim()
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(trimmed)
  if (paren) return { name: paren[1].trim(), variant: paren[2].trim() }
  const colon = /^(.*?)\s*:\s*(.+)$/.exec(trimmed)
  if (colon) return { name: colon[1].trim(), variant: colon[2].trim() }
  const space = /^(.*?)\s+(\S+)$/.exec(trimmed)
  if (space) return { name: space[1].trim(), variant: space[2].trim() }
  return { name: trimmed, variant: undefined }
}

/**
 * Resolve a runtime model to the baked GPT prompt-identity bucket it belongs to,
 * or `undefined` when it is not a recognized GPT identity. Astra is explicit: an
 * exact `gpt-6-astra` / `gpt-6-astra-fast` selector (with an optional reasoning
 * variant) maps to the Astra bucket; an accidental substring (`custom-gpt-6-astra`,
 * `gpt-6-astra-preview`, `gpt-6-astra-fastest`) or a non-reasoning variant does
 * not. Mirrors upstream `isGpt6AstraModel` (commit 2096e7805) for the Astra case.
 */
export function resolveGptPromptIdentityBucket(model) {
  const bare = extractModelName(model).toLowerCase().trim()
  if (!bare) return undefined
  const { name, variant } = splitSelectorVariant(bare)
  if (variant !== undefined && !REASONING_VARIANTS.has(variant)) return undefined
  if (name === "gpt-6-astra" || name === "gpt-6-astra-fast") return "gpt-6-astra"
  if (name === "gpt-6-sol" || name === "gpt-6-sol-fast") return "gpt-6-sol"
  if (name === "gpt-5.6-sol" || name === "gpt-5-6-sol" || name === "gpt-5.6-sol-fast") return "gpt-5.6-sol"
  if (name === "gpt-5.5" || name === "gpt-5-5") return "gpt-5.5"
  return undefined
}

function readText(part) {
  if (typeof part === "string") return part
  if (part && typeof part === "object" && typeof part.text === "string") return part.text
  return undefined
}

function writeText(part, text) {
  if (typeof part === "string") return text
  part.text = text
  return part
}

/**
 * Build the per-request reconciler.
 *
 * `bakedPrompt` is the exact body registered for `bakedModel`; `promptByModel`
 * maps a bare model name to the body registration would have built for it. The
 * returned `reconcile(system, runtimeModel, { agent })` performs the swap in
 * place and returns a verdict; `stats` exposes the per-model cache accounting
 * (`lookups` vs `cacheHits`) so a repeated request for the same model does not
 * re-resolve.
 */
export function createSisyphusPromptReconciler({
  agentId = SISYPHUS_AGENT_ID,
  bakedModel = "",
  bakedPrompt = "",
  promptByModel = {},
  onReconcile,
} = {}) {
  const bakedName = extractModelName(bakedModel)
  const map = promptByModel && typeof promptByModel === "object" && !Array.isArray(promptByModel)
    ? promptByModel
    : {}
  const cache = new Map()
  const stats = { lookups: 0, cacheHits: 0, swaps: 0 }

  function targetFor(name) {
    stats.lookups += 1
    if (cache.has(name)) {
      stats.cacheHits += 1
      return cache.get(name)
    }
    let value = typeof map[name] === "string" ? map[name] : undefined
    if (value === undefined) {
      // A gpt runtime selector that is not itself a baked key resolves to its
      // explicit prompt-identity bucket (Astra included); an unrecognized or
      // accidental selector resolves to nothing (stays a reported miss).
      const bucket = resolveGptPromptIdentityBucket(name)
      if (bucket && typeof map[bucket] === "string") value = map[bucket]
    }
    if (value !== undefined) cache.set(name, value)
    return value
  }

  function report(event) {
    onReconcile?.(event)
  }

  return {
    agentId,
    stats,
    reconcile(system, runtimeModel, { agent } = {}) {
      if (!isSisyphusAgent(agent)) return { reconciled: false, reason: "other-agent" }
      const runtimeName = extractModelName(runtimeModel)
      if (!runtimeName) return { reconciled: false, reason: "no-model" }
      if (!bakedPrompt) return { reconciled: false, reason: "no-baked-prompt" }
      // Same exact model => the baked body already matches; leave it untouched.
      if (runtimeName === bakedName) return { reconciled: false, reason: "configured-model" }
      const target = targetFor(runtimeName)
      if (target === undefined) {
        report({ agent: agentId, runtimeModel: runtimeName, reconciled: false, reason: "model-not-baked" })
        return { reconciled: false, reason: "model-not-baked" }
      }
      // Different name but a byte-identical body (e.g. two fallback-family
      // models): nothing to swap, matching V1's no-op suppression.
      if (target === bakedPrompt) {
        report({ agent: agentId, runtimeModel: runtimeName, reconciled: false, reason: "uniform" })
        return { reconciled: false, reason: "uniform" }
      }
      const parts = Array.isArray(system) ? system : []
      let swapped = false
      for (let i = 0; i < parts.length; i += 1) {
        const text = readText(parts[i])
        // Substring replace, not equality: V2 may wrap the agent body in one
        // system part alongside other text.
        if (text === undefined || !text.includes(bakedPrompt)) continue
        writeText(parts[i], text.split(bakedPrompt).join(target))
        swapped = true
      }
      if (swapped) {
        stats.swaps += 1
        report({ agent: agentId, runtimeModel: runtimeName, reconciled: true, reason: "swapped" })
      } else {
        report({ agent: agentId, runtimeModel: runtimeName, reconciled: false, reason: "body-absent" })
      }
      return { reconciled: swapped, reason: swapped ? "swapped" : "body-absent" }
    },
  }
}

/**
 * Provenance: upstream 65f159da3 "fix(prompts): show format examples as plain
 * lines, not quotes (#9538)". The model copies a format example as the shape of
 * its reply, so one written as a markdown quote line rendered whole answers as
 * blockquotes. V1 stays byte-identical to HEAD (untouchable); the V2 bake applies
 * the same fix to the Sisyphus body only, replacing the exact lines the commit
 * changed. This is a narrow table, not a generic quote-line normalizer, and it
 * never runs over another agent's body.
 */
export const SISYPHUS_FORMAT_EXAMPLE_PROVENANCE = "upstream 65f159da3"

const SISYPHUS_FORMAT_EXAMPLE_LINES = [
  [
    '> "I detect [research / implementation / investigation / evaluation / fix / open-ended] intent - [reason]. My approach: [explore → answer / plan → delegate / clarify first / etc.]."',
    '"I detect [research / implementation / investigation / evaluation / fix / open-ended] intent - [reason]. My approach: [explore → answer / plan → delegate / clarify first / etc.]."',
  ],
  [
    '> "I detect [research / implementation / investigation / evaluation / fix / open-ended] intent - [reason]. My approach: [plan]."',
    '"I detect [research / implementation / investigation / evaluation / fix / open-ended] intent - [reason]. My approach: [plan]."',
  ],
  [
    "> [Outcome so far] toward [the user's original ask and the result they wanted]. You need: [ledger N/M done, findings, blockers]. Now: [todo task in progress]. Next: [next open task].",
    "[Outcome so far] toward [the user's original ask and the result they wanted]. You need: [ledger N/M done, findings, blockers]. Now: [todo task in progress]. Next: [next open task].",
  ],
]

/** Apply the 65f159da3 format-example fix to a Sisyphus body. Idempotent. */
export function applySisyphusFormatExampleFix(body) {
  if (typeof body !== "string" || !body) return body
  let result = body
  for (const [quoted, plain] of SISYPHUS_FORMAT_EXAMPLE_LINES) {
    if (result.includes(quoted)) result = result.split(quoted).join(plain)
  }
  return result
}

/**
 * Apply the fix to the Sisyphus entry of an agents map and leave every other
 * entry reference-identical. The V2 manifest bake uses this so no other agent's
 * body is ever altered.
 */
export function fixSisyphusAgentMap(agents) {
  if (!agents || typeof agents !== "object") return agents
  const entry = agents[SISYPHUS_AGENT_ID]
  if (!entry || typeof entry.prompt !== "string") return agents
  return { ...agents, [SISYPHUS_AGENT_ID]: { ...entry, prompt: applySisyphusFormatExampleFix(entry.prompt) } }
}

/**
 * Dispose a bake-time plugin instance without letting a disposal failure abort
 * the bake. The failure is surfaced through `onError` (default: console.error),
 * never swallowed and never rethrown.
 */
export function disposeBakeHooks(hooks, label, onError = (message) => console.error(message)) {
  if (!hooks || typeof hooks.dispose !== "function") return Promise.resolve()
  return Promise.resolve()
    .then(() => hooks.dispose())
    .then(() => undefined)
    .catch((error) => {
      onError(`[oh-my-rigel] Sisyphus prompt bake dispose failed (${label}): ${error instanceof Error ? error.message : String(error)}`)
    })
}

/** Read the generator-materialized Sisyphus prompt plan from the manifest. */
export function readSisyphusPromptPlan(manifest) {
  const plan = manifest?.metadata?.global?.sisyphusPrompt
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return undefined
  const bakedModel = typeof plan.bakedModel === "string" ? plan.bakedModel : ""
  const bakedPrompt = typeof plan.bakedPrompt === "string" ? plan.bakedPrompt : ""
  const promptByModel = {}
  if (plan.promptByModel && typeof plan.promptByModel === "object" && !Array.isArray(plan.promptByModel)) {
    for (const [key, value] of Object.entries(plan.promptByModel)) {
      if (typeof value === "string" && value) promptByModel[key] = value
    }
  }
  if (!bakedPrompt) return undefined
  return { bakedModel, bakedPrompt, promptByModel }
}

/**
 * Build the reconciler from a manifest plan, or `undefined` when the manifest
 * carries no plan (a manifest generated before this contract, or a gates-off
 * profile). Returning `undefined` keeps the hook a pure no-op in that case.
 */
export function createSisyphusPromptReconcilerFromManifest(manifest, { onReconcile } = {}) {
  const plan = readSisyphusPromptPlan(manifest)
  if (!plan) return undefined
  return createSisyphusPromptReconciler({ ...plan, onReconcile })
}
