/**
 * Native V2 category resolution for Ho My Rigel.
 *
 * Category definitions are a frozen data export of the matching OmO revision.
 * This module deliberately does not import the V1 delegate-task runtime: it
 * resolves the currently available V2 models and produces a V2 ModelRef.
 */
import manifest from "./rigel-v2-category-manifest.mjs"

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

export async function resolveCategory(client, location, categoryName) {
  const name = String(categoryName ?? "").trim()
  const config = manifest.categories[name]
  if (!config) {
    throw new Error(`Unknown category: "${name}". Available categories: ${availableCategoryNames().join(", ")}`)
  }
  const configured = parseModel(config.model)
  if (!configured) {
    throw new Error(`Rigel category "${name}" has no valid model configuration.`)
  }
  const available = await listV2Models(client, location)
  const selected = findAvailable(configured, available)
  if (!selected) {
    const visible = available.map(modelKey).filter(Boolean).sort()
    throw new Error(`Category "${name}" requires ${config.model}, which is not available in this OpenCode V2 location. Available models: ${visible.join(", ")}`)
  }
  const selectedKey = modelKey(selected)
  const selectedModel = parseModel(selectedKey)
  return {
    name,
    description: manifest.descriptions[name],
    callerGuidance: manifest.guidance[name],
    promptAppend: manifest.prompts[name] ?? "",
    model: { ...selectedModel, ...(config.variant ? { variant: config.variant } : {}) },
    configuredModel: config.model,
  }
}

export function categoryTaskPrompt(prompt, category) {
  const appendix = category.promptAppend ? `\n\n${category.promptAppend}` : ""
  return `${prompt}${appendix}`
}
