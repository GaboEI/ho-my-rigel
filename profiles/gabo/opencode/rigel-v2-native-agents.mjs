/**
 * Converts the generated OmO V1 agent definitions into the V2 Agent.Info
 * fields that an AgentEditor owns.  The manifest is data only; this module is
 * the single place where the two contracts meet.
 */

const permissionAction = {
  bash: "shell",
  task: "subagent",
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
  // Info.default() already supplies a valid request and baseline rules.  The
  // generated definition is authoritative for every rule it declares.
  const rules = nativePermissionRules(source.permissions ?? source.permission)
  if (rules.length > 0) agent.permissions = rules
}

export async function registerNativeAgents(agentDomain, manifest) {
  if (typeof agentDomain?.transform !== "function" || typeof agentDomain?.reload !== "function") {
    throw new Error("OpenCode V2 agent.transform/agent.reload is unavailable")
  }
  const agents = manifest?.agents
  if (!agents || typeof agents !== "object") throw new Error("Rigel native agent manifest is invalid")
  await agentDomain.transform((editor) => {
    for (const [id, definition] of Object.entries(agents)) {
      editor.update(id, (agent) => applyLegacyAgentDefinition(agent, id, definition))
    }
    if (typeof manifest.defaultAgent === "string" && agents[manifest.defaultAgent]) editor.default(manifest.defaultAgent)
  })
  await agentDomain.reload()
  return Object.keys(agents)
}
