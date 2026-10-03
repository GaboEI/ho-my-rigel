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
    const id = entry.id ?? nested.id ?? name
    const mode = entry.mode ?? nested.mode ?? entry.config?.mode ?? nested.config?.mode
    if (typeof name !== "string" || typeof id !== "string" || typeof mode !== "string") return []
    return [{ id, name, mode, hidden: Boolean(entry.hidden ?? nested.hidden) }]
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
  // case-insensitively, but preserve V2's stable `id` for session.create.
  const alias = requested.toLocaleLowerCase() === "plan" ? "prometheus - plan builder" : requested
  const agent = agents.find((candidate) => candidate.name === alias)
    ?? agents.find((candidate) => candidate.name.toLocaleLowerCase() === alias.toLocaleLowerCase())
  if (agent) {
    console.error(`[ho-my-rigel] Native V2 agent resolved: requested=${requested}; canonical=${agent.name}; id=${agent.id}`)
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

function contextData(response) {
  return Array.isArray(response) ? response : (response?.data ?? [])
}

export function completedChildText(response) {
  const messages = contextData(response)
  if (!Array.isArray(messages)) return ""
  const assistant = [...messages].reverse().find((message) => message?.type === "assistant")
  const text = assistant?.content
    ?.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
  return text ?? ""
}

export async function delegateNamedAgent({ client, location, agent, prompt, background = false, model, parentSessionID, onChildSession }) {
  const sessions = sessionApi(client)
  const created = await sessions.create({
    agent: agent.id ?? agent.name,
    location,
    ...(parentSessionID ? { parentID: parentSessionID } : {}),
    ...(model ? { model } : {}),
  })
  const sessionID = sessionIdFrom(created)
  onChildSession?.(sessionID, { model, agent: agent.id ?? agent.name })
  await sessions.prompt({
    sessionID,
    // Plugin V2's SessionDomain takes PromptInput fields directly. The SDK
    // client wraps this as `prompt: { text }`, but this domain does not.
    text: childTaskPrompt(prompt),
    // V2 schedules the agent loop unless `resume` is explicitly false. Both
    // modes must therefore resume; foreground work is distinguished by the
    // `wait()` boundary below, not by suppressing child execution.
    resume: true,
  })
  if (background) return { sessionID, agent: agent.name, background }

  // `wait` is the native V2 foreground boundary. It is deliberately exercised
  // by the isolated V2 delegation contract: only after it resolves do we read
  // the child's final text and hand it back as the actual tool result.
  if (typeof sessions.wait !== "function" || typeof sessions.context !== "function") {
    throw new Error("OpenCode V2 session.wait/session.context is unavailable for foreground delegation")
  }
  await sessions.wait({ sessionID })
  const result = completedChildText(await sessions.context({ sessionID }))
  return { sessionID, agent: agent.name, background, result }
}

export async function resumeDelegatedSession({ client, sessionID, prompt, background = false }) {
  const sessions = sessionApi(client)
  await sessions.prompt({ sessionID, text: childTaskPrompt(prompt), resume: true })
  if (background) return { sessionID, agent: "resumed", background }
  if (typeof sessions.wait !== "function" || typeof sessions.context !== "function") {
    throw new Error("OpenCode V2 session.wait/session.context is unavailable for foreground continuation")
  }
  await sessions.wait({ sessionID })
  return { sessionID, agent: "resumed", background, result: completedChildText(await sessions.context({ sessionID })) }
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

export async function resumeDelegatedSessionFromClients({ clients, ...input }) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      return await resumeDelegatedSession({ ...input, client })
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 child session could not be resumed: ${diagnostics.join("; ")}`)
}

export function taskResult({ sessionID, agent, background, result }) {
  const lifecycle = background
    ? "The subagent is working in the background."
    : "The subagent has been started."
  const returned = background
    ? `${lifecycle} sessionID: ${sessionID}; agent: ${agent}.`
    : `The subagent completed. sessionID: ${sessionID}; agent: ${agent}.\n\n<rigel-native-child-result>\n${result || "(The child returned no text.)"}\n</rigel-native-child-result>`
  return {
    content: returned,
    metadata: { sessionID, agent, background },
  }
}

/**
 * Turn a completed native child into a fresh parent turn. This is a prompt,
 * because V2 already completed the original tool turn when a background child
 * settles; a synthetic tool result would misrepresent that lifecycle.
 */
export function backgroundHandoffPrompt({ sessionID, agent, status, result }) {
  const detail = status === "succeeded"
    ? (result || "(The child completed without visible text.)")
    : `(The child ${status ?? "ended"} before returning a result.)`
  return `<rigel-native-background-result>\nagent: ${agent}\nsessionID: ${sessionID}\nstatus: ${status ?? "unknown"}\n${detail}\n</rigel-native-background-result>`
}
