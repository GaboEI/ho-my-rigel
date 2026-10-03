/**
 * Native V2 category resolution for Ho My Rigel.
 *
 * Category definitions are a frozen data export of the matching OmO revision.
 * This module deliberately does not import the V1 delegate-task runtime: it
 * resolves the currently available V2 models and produces a V2 ModelRef.
 *
 * The canonical fallback chain (ported in `rigel-v2-native-model-chains.mjs`)
 * is the source of truth for which model a category runs on. The manifest still
 * owns the description/guidance/prompt text and the primary lane used as a
 * fallback when a chain is somehow absent.
 */
import manifest from "./rigel-v2-category-manifest.mjs"
import { categoryChain, resolveFallbackModel } from "./rigel-v2-native-model-chains.mjs"

function dataOf(response) {
  return Array.isArray(response) ? response : (response?.data ?? [])
}

function modelKey(model) {
  if (!model || typeof model !== "object") return undefined
  const providerID = model.providerID ?? model.provider
  const id = model.id ?? model.modelID
  return typeof providerID === "string" && typeof id === "string" ? `${providerID}/${id}` : undefined
}

function parseModel(value) {
  if (typeof value !== "string") return undefined
  const match = /^([^/]+)\/(.+?)(?:\(([^)]+)\))?$/.exec(value.trim())
  if (!match) return undefined
  return { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) }
}

function comparable(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function findAvailable(configured, available) {
  const exact = available.find((row) => modelKey(row) === `${configured.providerID}/${configured.id}`)
  if (exact) return exact
  // Providers sometimes publish a harmless suffix/punctuation variant.  We
  // only accept a match inside the same provider, never cross-route a model.
  return available.find((row) => {
    const key = modelKey(row)
    if (!key) return false
    const parsed = parseModel(key)
    return parsed?.providerID === configured.providerID && comparable(parsed.id) === comparable(configured.id)
  })
}

export async function listV2Models(client, location) {
  const api = client?.v2?.model ?? client?.model
  if (typeof api?.list !== "function") {
    throw new Error("OpenCode V2 model.list is unavailable")
  }
  const result = await api.list({ location })
  return dataOf(result).filter((row) => modelKey(row) !== undefined && row.enabled !== false)
}

/**
 * Resolve the V2 model inventory from the first client that can answer it.
 * Setup and tool-execution clients expose different endpoint subsets, so a
 * total miss is a real error the caller decides how to surface.
 */
export async function listV2ModelsFromClients(clients, location) {
  const diagnostics = []
  for (const client of (Array.isArray(clients) ? clients : []).filter(Boolean)) {
    try {
      return await listV2Models(client, location)
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 model inventory is unavailable: ${diagnostics.join("; ")}`)
}

export async function resolveCategoryFromClients(clients, location, categoryName) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      return await resolveCategory(client, location, categoryName)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A semantic category error must not be hidden by probing another
      // client. Only endpoint-shape failures justify trying the next client.
      if (!/model\.list is unavailable/i.test(message)) throw error
      diagnostics.push(message)
    }
  }
  throw new Error(`OpenCode V2 category model inventory is unavailable: ${diagnostics.join("; ")}`)
}

export function availableCategoryNames() {
  return Object.keys(manifest.categories).sort()
}

function manifestLane(config, available) {
  const configured = parseModel(config.model)
  if (!configured) return undefined
  const row = findAvailable(configured, available)
  if (!row) return undefined
  const selected = parseModel(modelKey(row))
  return selected ? { ...selected, ...(config.variant ? { variant: config.variant } : {}) } : undefined
}

export async function resolveCategory(client, location, categoryName) {
  const name = String(categoryName ?? "").trim()
  const config = manifest.categories[name]
  if (!config) {
    throw new Error(`Unknown category: "${name}". Available categories: ${availableCategoryNames().join(", ")}`)
  }
  const available = await listV2Models(client, location)
  const chain = categoryChain(name)
  // First reachable rung of the canonical chain, provider-scoped per rung.
  // `sameProviderAs` is intentionally omitted: category resolution runs before
  // V2 selects the provider, so choosing a rung on another provider is
  // legitimate here and is not the post-selection misroute the HTTP hook
  // guards against. A category with no canonical chain falls back to its
  // manifest lane.
  const selected = Array.isArray(chain) && chain.length > 0
    ? resolveFallbackModel({ chain, availableModels: available })
    : manifestLane(config, available)
  if (!selected) {
    const visible = available.map(modelKey).filter(Boolean).sort()
    const required = Array.isArray(chain) && chain.length > 0
      ? chain.map((entry) => entry.model).join(", ")
      : config.model
    throw new Error(`Category "${name}" requires one of its canonical fallback models (${required}), none of which is available in this OpenCode V2 location. Available models: ${visible.join(", ")}`)
  }
  return {
    name,
    description: manifest.descriptions[name],
    callerGuidance: manifest.guidance[name],
    promptAppend: manifest.prompts[name] ?? "",
    model: selected,
    configuredModel: config.model,
  }
}

export function categoryTaskPrompt(prompt, category) {
  const appendix = category.promptAppend ? `\n\n${category.promptAppend}` : ""
  return `${prompt}${appendix}`
}
