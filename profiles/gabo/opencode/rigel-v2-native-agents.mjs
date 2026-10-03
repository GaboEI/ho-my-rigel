/**
 * Converts the generated OmO V1 agent definitions into the V2 Agent.Info
 * fields that an AgentEditor owns.  The manifest is data only; this module is
 * the single place where the two contracts meet.
 *
 * Proactive model fallback lives here, at the V2 pre-selection boundary.
 * `agent.transform` runs before `agent.reload`, which runs before V2 resolves
 * the provider/model for a request. Setting `agent.model` here therefore
 * selects the first available chain rung before V2 ever validates the primary,
 * unlike the `http.request` boundary which runs after provider selection and
 * can only guard same-provider rewrites. The manifest model stays as the
 * fallback when the live inventory cannot answer, so setup never fails closed.
 */

import { agentChain, resolveFallbackModel } from "./rigel-v2-native-model-chains.mjs"

const permissionAction = {
  bash: "shell",
  task: "subagent",
}

const tuningKeys = ["temperature", "top_p", "maxTokens", "thinking", "reasoning", "reasoningEffort", "textVerbosity"]

function invalidTuning(key) {
  throw new TypeError(`Invalid native agent tuning field: ${key}`)
}

function validatedTuningValue(key, value) {
  if (key === "temperature") {
    if (!Number.isFinite(value) || value < 0 || value > 2) invalidTuning(key)
    return value
  }
  if (key === "top_p") {
    if (!Number.isFinite(value) || value < 0 || value > 1) invalidTuning(key)
    return value
  }
  if (key === "maxTokens") {
    if (!Number.isInteger(value) || value <= 0) invalidTuning(key)
    return value
  }
  if (key === "thinking") {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !["enabled", "disabled"].includes(value.type)
      || (value.budgetTokens !== undefined && (!Number.isFinite(value.budgetTokens) || value.budgetTokens <= 0))) {
      invalidTuning(key)
    }
    return { type: value.type, ...(value.budgetTokens === undefined ? {} : { budgetTokens: value.budgetTokens }) }
  }
  if (key === "reasoning" || key === "reasoningEffort") {
    if (typeof value !== "string" || !value.trim()) invalidTuning(key)
    return value.trim()
  }
  if (key === "textVerbosity") {
    if (!["low", "medium", "high"].includes(value)) invalidTuning(key)
    return value
  }
  invalidTuning(key)
}

export function agentRequestBodyFromDefinition(definition) {
  const source = definition && typeof definition === "object" && !Array.isArray(definition) ? definition : {}
  if (source.reasoning !== undefined && source.reasoningEffort !== undefined) {
    throw new TypeError("Conflicting native agent tuning fields: reasoning and reasoningEffort")
  }
  const body = {}
  for (const key of tuningKeys) {
    if (source[key] !== undefined) body[key] = validatedTuningValue(key, source[key])
  }
  return body
}

function modelRef(value, variant) {
  if (typeof value !== "string") return undefined
  const match = /^([^/]+)\/(.+)$/.exec(value.trim())
  if (!match) return undefined
  return { providerID: match[1], id: match[2], ...(typeof variant === "string" ? { variant } : {}) }
}

function rulesFor(action, value) {
  const mapped = permissionAction[action] ?? action
  if (typeof value === "string") return [{ action: mapped, resource: "*", effect: value }]
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([resource, effect]) => (
    typeof effect === "string" ? [{ action: mapped, resource, effect }] : []
  ))
}

export function nativePermissionRules(permission) {
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return []
  return Object.entries(permission).flatMap(([action, value]) => rulesFor(action, value))
}

export function applyLegacyAgentDefinition(agent, id, definition) {
  const source = definition && typeof definition === "object" ? definition : {}
  agent.name = typeof source.name === "string" ? source.name : id
  agent.description = typeof source.description === "string" ? source.description : undefined
  agent.mode = ["primary", "subagent", "all"].includes(source.mode) ? source.mode : "subagent"
  agent.hidden = Boolean(source.hidden)
  agent.system = typeof source.system === "string" ? source.system : (typeof source.prompt === "string" ? source.prompt : undefined)
  agent.color = typeof source.color === "string" ? source.color : undefined
  agent.steps = Number.isFinite(source.steps) ? source.steps : undefined
  const model = modelRef(source.model, source.variant)
  if (model) agent.model = model
  const request = agent.request && typeof agent.request === "object" && !Array.isArray(agent.request) ? agent.request : {}
  const requestBody = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body : {}
  agent.request = { ...request, body: { ...requestBody, ...agentRequestBodyFromDefinition(source) } }
  // Info.default() already supplies a valid request and baseline rules.  The
  // generated definition is authoritative for every rule it declares.
  const rules = nativePermissionRules(source.permissions ?? source.permission)
  if (rules.length > 0) agent.permissions = rules
}

function chainHeadRef(chain) {
  const head = Array.isArray(chain) ? chain[0] : undefined
  if (!head || typeof head.model !== "string") return undefined
  const providerID = Array.isArray(head.providers) ? head.providers[0] : undefined
  if (typeof providerID !== "string") return undefined
  return { providerID, id: head.model, ...(head.variant ? { variant: head.variant } : {}) }
}

/**
 * Resolve the model each agent should start on, at the pre-selection
 * `agent.transform` boundary.
 *
 * For every agent that owns a canonical chain, pick the first rung reachable on
 * the live inventory (any provider: V2 has not selected one yet, so a
 * cross-provider rung is a legitimate choice here, not the post-selection
 * misroute the HTTP hook guards). When the inventory is unavailable or the
 * agent has no chain, fall back to that agent's manifest model so setup never
 * fails closed. Returns a map of agent id -> model ref.
 *
 * `listModels` is optional: when absent the manifest models are used unchanged.
 */
export function resolveProactiveAgentModels(agents, listModels) {
  const resolved = new Map()
  if (!agents || typeof agents !== "object") return resolved
  const inventory = Array.isArray(listModels) ? listModels : undefined
  for (const [id, definition] of Object.entries(agents)) {
    const source = definition && typeof definition === "object" ? definition : {}
    const current = modelRef(source.model, source.variant)
    const chain = agentChain(id)
    let next
    if (Array.isArray(inventory) && Array.isArray(chain) && chain.length > 0) {
      next = resolveFallbackModel({ chain, availableModels: inventory })
    }
    // Canonical chain head is the pre-selection preference; the manifest model
    // is the last resort when neither inventory nor chain can answer.
    resolved.set(id, next ?? current ?? chainHeadRef(chain))
  }
  return resolved
}

export async function registerNativeAgents(agentDomain, manifest, { listModels, onAgentRequest } = {}) {
  if (typeof agentDomain?.transform !== "function" || typeof agentDomain?.reload !== "function") {
    throw new Error("OpenCode V2 agent.transform/agent.reload is unavailable")
  }
  const agents = manifest?.agents
  if (!agents || typeof agents !== "object") throw new Error("Rigel native agent manifest is invalid")
  // Inventory is read once, before the transform, so the whole roster resolves
  // against a single consistent snapshot. A failed read degrades to manifest
  // models instead of blocking agent registration.
  let inventory
  if (typeof listModels === "function") {
    try {
      inventory = await listModels()
    } catch (error) {
      console.error(`[ho-my-rigel] Native V2 agent inventory unavailable; using manifest models: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const proactiveModels = resolveProactiveAgentModels(agents, Array.isArray(inventory) ? inventory : undefined)
  await agentDomain.transform((editor) => {
    for (const [id, definition] of Object.entries(agents)) {
      editor.update(id, (agent) => {
        applyLegacyAgentDefinition(agent, id, definition)
        const proactive = proactiveModels.get(id)
        if (proactive) agent.model = proactive
        onAgentRequest?.(id, agent.request.body)
      })
    }
    if (typeof manifest.defaultAgent === "string" && agents[manifest.defaultAgent]) editor.default(manifest.defaultAgent)
  })
  await agentDomain.reload()
  return Object.keys(agents)
}
