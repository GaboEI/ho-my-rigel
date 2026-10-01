/**
 * Native OpenCode V2 runtime primitives for Ho My Rigel.
 *
 * This module deliberately has no dependency on OmO's V1 plugin contract.
 * It uses V2's location-scoped agent and session APIs directly.
 */

const callableModes = new Set(["subagent", "all"])
import { childTaskPrompt } from "./rigel-v2-native-prompt.mjs"

export function normalizeAgentInventory(response) {
  const data = Array.isArray(response) ? response : (response?.data ?? response?.agents)
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const nested = entry.agent && typeof entry.agent === "object" ? entry.agent : {}
    const name = entry.name ?? entry.id ?? nested.name ?? nested.id
    const mode = entry.mode ?? nested.mode ?? entry.config?.mode ?? nested.config?.mode
    if (typeof name !== "string" || typeof mode !== "string") return []
    return [{ name, mode, hidden: Boolean(entry.hidden ?? nested.hidden) }]
  })
}

export function callableAgents(response) {
  return normalizeAgentInventory(response).filter((agent) => callableModes.has(agent.mode) && !agent.hidden)
}

export async function listCallableAgents(client, location) {
  if (typeof client?.agent?.list === "function") {
    return callableAgents(await client.agent.list({ location }))
  }
  // OpenCode V2 currently exposes this same location-scoped inventory through
  // app.agents on plugin setup contexts. It is a V2 host surface, not a V1
  // fallback: the essential requirement is supplying the location explicitly.
  if (typeof client?.app?.agents === "function") {
    return callableAgents(await client.app.agents({
      directory: location?.directory,
      ...(location?.workspace ? { workspace: location.workspace } : {}),
    }))
  }
  throw new Error("OpenCode V2 agent inventory API is unavailable")
}

/**
 * V2 exposes a setup client and a tool-execution client.  They need not carry
 * the same endpoint subsets, so inventory is intentionally resolved from the
 * first client that can answer it, never from an assumed global singleton.
 */
export async function listCallableAgentsFromClients(clients, location) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      const agents = await listCallableAgents(client, location)
      if (agents.length > 0) return agents
      diagnostics.push("inventory returned no callable agents")
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 callable-agent inventory is unavailable: ${diagnostics.join("; ")}`)
}

export function resolveNamedAgent(agents, requestedName) {
  const requested = String(requestedName ?? "").trim()
  // OmO's prompts use stable lowercase identifiers (`explore`, `oracle`),
  // while V2 can surface a display-cased builtin (`Explore`). Resolve names
  // case-insensitively but keep the host's canonical name for session.create.
  const agent = agents.find((candidate) => candidate.name === requested)
    ?? agents.find((candidate) => candidate.name.toLocaleLowerCase() === requested.toLocaleLowerCase())
  if (agent) {
    console.error(`[ho-my-rigel] Native V2 agent resolved: requested=${requested}; canonical=${agent.name}`)
    return agent
  }
  const available = agents.map((candidate) => candidate.name).sort()
  throw new Error(`Unknown agent: "${requested}". Available agents: ${available.join(", ")}`)
}

function sessionApi(client) {
  // OpenCode V2 plugin hosts expose the V2 session surface directly. Keeping
  // this resolver small also gives a precise diagnostic if a host changes its
  // API instead of silently falling back to a V1 endpoint.
  const api = client?.v2?.session ?? client?.session
  if (typeof api?.create !== "function" || typeof api?.prompt !== "function") {
    throw new Error("OpenCode V2 session.create/session.prompt is unavailable")
  }
  return api
}

function responseData(response) {
  return response?.data ?? response
}

function sessionIdFrom(response) {
  const data = responseData(response)
  const id = data?.id ?? data?.sessionID ?? data?.session?.id
  if (typeof id !== "string" || id.length === 0) throw new Error("OpenCode V2 did not return a child session ID")
  return id
}

export async function delegateNamedAgent({ client, location, agent, prompt, background = true, model }) {
  const sessions = sessionApi(client)
  const created = await sessions.create({ agent: agent.name, location, ...(model ? { model } : {}) })
  const sessionID = sessionIdFrom(created)
  await sessions.prompt({
    sessionID,
    // Plugin V2's SessionDomain takes PromptInput fields directly. The SDK
    // client wraps this as `prompt: { text }`, but this domain does not.
    text: childTaskPrompt(prompt),
    // A background task must be independently scheduled. The parent session
    // receives the child ID and OpenCode owns its lifecycle thereafter.
    resume: background,
  })
  return { sessionID, agent: agent.name, background }
}

export async function delegateNamedAgentFromClients({ clients, ...input }) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      return await delegateNamedAgent({ ...input, client })
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 child session could not be created: ${diagnostics.join("; ")}`)
}

export function taskResult({ sessionID, agent, background }) {
  const lifecycle = background
    ? "The subagent is working in the background."
    : "The subagent has been started."
  return {
    content: `${lifecycle} sessionID: ${sessionID}; agent: ${agent}.`,
    metadata: { sessionID, agent, background },
  }
}
