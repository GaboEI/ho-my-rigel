/**
 * Native V2 registration gate for the Hephaestus agent in Ho My Rigel.
 *
 * Plain-JS port of the matching OmO revision:
 *   packages/omo-opencode/src/agents/hephaestus/agent.ts (model support, lines 18-55)
 *   packages/omo-opencode/src/agents/builtin-agents/hephaestus-agent.ts (provider + model gate, lines 42-88)
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so the gate
 * lives here as plain functions. `rigel-v2-native-hephaestus.test.mjs` imports
 * the real TS owners and pins deep parity, so upstream drift fails the suite.
 *
 * V2 semantic for an empty model inventory: the provider check is skipped.
 * V2 has no `isFirstRunNoCache` flag, so an empty list cannot be told apart
 * from a first run with no caches yet; skipping keeps the V1 first-run
 * behaviour (register) instead of silently dropping the agent.
 */

export const HEPHAESTUS_AGENT_KEY = "hephaestus"

export const HEPHAESTUS_REQUIRED_PROVIDERS = ["openai", "chatgpt-subscription", "github-copilot", "opencode"]

const GPT_5_3_CODEX_RE = /^gpt-5[.-]3-codex(?:$|[.-])/i
const GPT_5_4_RE = /^gpt-5[.-]4(?:$|[.-])/i
const GPT_5_5_RE = /^gpt-5[.-]5(?:$|[.-])/i
const GPT_5_6_RE = /^gpt-5[.-]6(?:$|[.-])/i
const GPT_6_RE = /^gpt-6(?:$|[.-])/i
const HOSTED_VENDOR_PREFIX_RE = /^(?:[^./]+\.)+(gpt-5[.-].*)$/i

function extractModelName(model) {
  const afterProvider = model.includes("/") ? (model.split("/").pop() ?? model) : model
  return HOSTED_VENDOR_PREFIX_RE.exec(afterProvider)?.[1] ?? afterProvider
}

/**
 * True when a model id is one of the GPT variants Hephaestus runs on. A hosted
 * `vendor.` / region prefix is stripped first, so Bedrock-style ids such as
 * `amazon-bedrock/us.openai.gpt-5.4` still route.
 */
export function isHephaestusSupportedModel(model) {
  if (!model) return false
  const modelName = extractModelName(model)
  return (
    GPT_5_3_CODEX_RE.test(modelName) ||
    GPT_5_4_RE.test(modelName) ||
    GPT_5_5_RE.test(modelName) ||
    GPT_5_6_RE.test(modelName) ||
    GPT_6_RE.test(modelName)
  )
}

/**
 * True for the canonical `hephaestus` id and for V2 display names such as
 * `Hephaestus - Deep Agent` (the base id before the ` - ` display suffix).
 */
export function isHephaestusAgentId(id) {
  const normalized = String(id ?? "").trim().toLocaleLowerCase().split(/\s+-\s+/)[0].trim()
  return normalized === HEPHAESTUS_AGENT_KEY
}

function parseModelRef(value) {
  if (!value || typeof value !== "object") return undefined
  const id = value.id ?? value.modelID
  if (typeof id !== "string" || id.length === 0) return undefined
  const providerID = value.providerID ?? value.provider
  return {
    ...(typeof providerID === "string" && providerID ? { providerID } : {}),
    id,
  }
}

function parseDefinitionModel(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const match = /^([^/]+)\/(.+)$/.exec(trimmed)
  return match ? { providerID: match[1], id: match[2] } : { id: trimmed }
}

function connectedProviders(inventory) {
  const providers = new Set()
  for (const row of inventory) {
    const providerID = row?.providerID ?? row?.provider
    if (typeof providerID === "string" && providerID) providers.add(providerID)
  }
  return providers
}

function providerSkippedMessage() {
  return `[ho-my-rigel] [agent-registration] Agent skipped: required provider not connected (agent=${HEPHAESTUS_AGENT_KEY}; requiredProvider=${HEPHAESTUS_REQUIRED_PROVIDERS.join("|")})`
}

function modelSkippedMessage(id) {
  return `[ho-my-rigel] [agent-registration] Agent skipped: unsupported Hephaestus model (agent=${HEPHAESTUS_AGENT_KEY}; model=${id ?? "undefined"})`
}

/**
 * Pure registration decision, mirroring V1 `maybeCreateHephaestusConfig`.
 *
 * - `definition` is the plain manifest definition; only `definition.model` is
 *   read, and only when `model` is absent.
 * - `model` is the resolved V2 ref `{ providerID?, id }`.
 * - `inventory` is a `listV2ModelsFromClients` row list (`providerID` or
 *   `provider`, plus `id`). A non-empty inventory gates on the required
 *   providers; an undefined or empty inventory skips the provider check.
 *
 * Returns `{ eligible: true, model }` or `{ eligible: false, reason, message }`.
 */
export function evaluateHephaestusGate({ definition, model, inventory } = {}) {
  let resolved = parseModelRef(model)
  if (!resolved) resolved = parseDefinitionModel(definition?.model)

  const rows = Array.isArray(inventory) ? inventory : []
  if (rows.length > 0) {
    const connected = connectedProviders(rows)
    const satisfied = HEPHAESTUS_REQUIRED_PROVIDERS.some((providerID) => connected.has(providerID))
    if (!satisfied) {
      return { eligible: false, reason: "provider", message: providerSkippedMessage() }
    }
  }

  if (!resolved || !isHephaestusSupportedModel(resolved.id)) {
    return { eligible: false, reason: "model", message: modelSkippedMessage(resolved?.id) }
  }

  return {
    eligible: true,
    model: {
      ...(resolved.providerID ? { providerID: resolved.providerID } : {}),
      id: resolved.id,
    },
  }
}
