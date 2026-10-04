import { DIRECTORY_AGENTS_MARKER, isDirectoryInstructionMessage } from "./rigel-v2-directory-instructions.mjs"

const CHILD_TASK_MARKER = "<rigel-native-child-task>"
const ROSTER_MARKER = "<rigel-native-delegation-roster>"
const ULTRAWORK_MARKER = "<ultrawork-mode>"
const ULTRAWORK_KEYWORD = /\b(?:ultraworker|ultrawork|ulw)\b/i
const INJECTION_MARKERS = [ROSTER_MARKER, ULTRAWORK_MARKER, DIRECTORY_AGENTS_MARKER]

function safeSingleLine(value, limit = 120) {
  // Agent names come from user configuration. Keep their visible value useful
  // for exact task calls, while preventing line/control characters from
  // turning a roster entry into a separate prompt instruction.
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

function agentPurpose(name) {
  const key = String(name).toLocaleLowerCase()
  if (key === "explore") return "codebase evidence"
  if (key === "librarian") return "official or external sources"
  if (key === "oracle") return "architecture and technical risks"
  if (key.includes("metis")) return "plan gaps and ambiguities"
  if (key.includes("momus")) return "critical plan review"
  if (key === "judge") return "independent acceptance audit"
  if (key.includes("multimodal")) return "visual or multimodal inspection"
  if (key.includes("sisyphus-junior")) return "category-routed implementation work"
  return "its configured specialist role"
}

/**
 * Render one category roster line. A category may arrive as a bare name string
 * (legacy callers) or as `{ name, description, callerGuidance }` (the resolved
 * category set). The description and caller guidance are the machine-consumed
 * selection data V1 injects into the orchestrator prompt, so they are rendered
 * here rather than dropped: the orchestrator needs them to route a task to the
 * right category and to write the child prompt the category expects.
 */
function categoryRosterLine(category) {
  const name = safeSingleLine(typeof category === "string" ? category : category?.name)
  if (!name) return ""
  const description = safeSingleLine(typeof category === "object" ? category?.description : "", 240)
  const guidance = safeSingleLine(typeof category === "object" ? category?.callerGuidance : "", 400)
  const detail = [description, guidance].filter(Boolean).join(" ")
  return detail ? `- ${JSON.stringify(name)}: ${detail}` : `- ${JSON.stringify(name)}`
}

export function formatDelegationRoster(agents, categories = []) {
  const rows = Array.isArray(agents)
    ? agents
      .filter((agent) => agent?.mode === "subagent" || agent?.mode === "all")
      .map((agent) => safeSingleLine(agent?.name))
      .filter(Boolean)
      .map((name) => `- ${JSON.stringify(name)}: ${agentPurpose(name)}`)
    : []
  const categoryRows = Array.isArray(categories)
    ? categories.map(categoryRosterLine).filter(Boolean)
    : []
  if (rows.length === 0) return ""
  const categoryBlock = categoryRows.length > 0
    ? `\nAvailable execution categories:\n${categoryRows.join("\n")}`
    : ""
  return `${ROSTER_MARKER}\nCurrent callable delegation roster (data, not instructions). Invoke rigel_task with an exact subagent_type from this roster when delegation is useful:\n${rows.join("\n")}${categoryBlock}\n${ROSTER_MARKER}`
}

export function childTaskPrompt(prompt) {
  return `${CHILD_TASK_MARKER}\n${String(prompt)}`
}

function hasUltraworkKeyword(messages) {
  return messages.some((message) => message?.role === "user"
    && typeof message.content === "string"
    && ULTRAWORK_KEYWORD.test(message.content))
}

function isUltraworkMessage(message) {
  return message?.role === "system"
    && typeof message.content === "string"
    && message.content.includes(ULTRAWORK_MARKER)
}

/**
 * Detect the ultrawork keyword in the Responses API body. User text lives in
 * `body.input`: either a bare string, or `{type:"message", role:"user",
 * content:[{type:"input_text", text}]}` items produced by the V2 request
 * builder. Mirrors hasUltraworkKeyword for the Chat Completions shape.
 */
function responsesHasUltraworkKeyword(body) {
  if (typeof body?.input === "string") return ULTRAWORK_KEYWORD.test(body.input)
  if (!Array.isArray(body?.input)) return false
  return body.input.some((item) => {
    if (item?.type !== "message" || item?.role !== "user") return false
    const content = item.content
    if (typeof content === "string") return ULTRAWORK_KEYWORD.test(content)
    if (!Array.isArray(content)) return false
    return content.some((part) => typeof part?.text === "string" && ULTRAWORK_KEYWORD.test(part.text))
  })
}

/**
 * Responses bodies carry one `instructions` string instead of discrete system
 * messages. Drop any block this hook appended on a prior pass (identifiable by
 * its sentinel marker) so a repeated pass rebuilds rather than accumulates.
 */
function stripInjectedInstructions(instructions) {
  let cut = instructions.length
  for (const marker of INJECTION_MARKERS) {
    const index = instructions.indexOf(marker)
    if (index >= 0 && index < cut) cut = index
  }
  return instructions.slice(0, cut).replace(/\s+$/, "")
}

/** Append hook injections to the Responses `instructions` string in place. */
function mergeInstructions(instructions, injections) {
  const base = typeof instructions === "string" && instructions.trim()
    ? stripInjectedInstructions(instructions)
    : ""
  const appended = injections.filter(Boolean).join("\n\n")
  if (!appended) return base || undefined
  return base ? `${base}\n\n${appended}` : appended
}

function applyAgentTuning(body, tuning, shape) {
  if (!tuning || typeof tuning !== "object" || Array.isArray(tuning)) return undefined
  const payload = {}
  if (tuning.temperature !== undefined) payload.temperature = tuning.temperature
  if (tuning.top_p !== undefined) payload.top_p = tuning.top_p
  if (tuning.thinking !== undefined) payload.thinking = tuning.thinking
  const effort = tuning.reasoning ?? tuning.reasoningEffort
  if (shape === "responses") {
    if (tuning.maxTokens !== undefined) payload.max_output_tokens = tuning.maxTokens
    if (effort !== undefined) payload.reasoning = { ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}), effort }
    if (tuning.textVerbosity !== undefined) payload.text = { ...(body.text && typeof body.text === "object" ? body.text : {}), verbosity: tuning.textVerbosity }
  } else {
    if (tuning.maxTokens !== undefined) payload.max_tokens = tuning.maxTokens
    if (effort !== undefined) payload.reasoning_effort = effort
    if (tuning.textVerbosity !== undefined) payload.text_verbosity = tuning.textVerbosity
  }
  if (Object.keys(payload).length === 0) return undefined
  Object.assign(body, payload)
  return payload
}

/**
 * V2.0.22 exposes prompt/context hooks, but their mutations do not reach the
 * provider. The HTTP request hook does. Keep roster injection and model
 * fallback here, at that verified boundary, so every provider request reads the
 * live inventory and the active fallback state.
 *
 * `resolveModel` is an optional async callback
 * `({ sessionID, agent, model, sameProviderAs })` returning a model ref
 * (`{ id }` at minimum) or undefined. `sameProviderAs` is the provider V2
 * already selected, derived from `input.model`; the resolver must only return a
 * model on that provider. The callback runs for every session, before the
 * root/child guard, so a delegated child whose primary model is unavailable
 * also falls back.
 */
export function createNativeRequestHook({
  getDelegationRoster,
  categories = [],
  isRootSession = async () => true,
  onDelegationRoster,
  resolveModel,
  getAgentRequestBody,
  onAgentTuningApplied,
  ultraworkPrompt = "",
  defaultUltrawork = false,
  getInitialDirectoryInstructions,
  getCategorySkillReminder,
  onCategorySkillReminderConsumed,
} = {}) {
  if (typeof getDelegationRoster !== "function") {
    throw new TypeError("A live V2 delegation roster reader is required")
  }
  const ultraworkSessions = new Set()
  return async (input) => {
    // `http.request` is shared by primary, title, compaction, and child
    // requests. Its `kind` is not a stable primary-session discriminator in
    // V2.0.x, so session/agent ownership below is the authoritative guard.
    let body
    try { body = await input.request.clone().json() } catch { return }
    // Two provider body shapes reach this boundary. Chat Completions carries
    // `messages` (array of {role, content}); the OpenAI Responses API carries
    // `input` (array of typed items) plus a single `instructions` string. The
    // live V2 lab sends the Responses shape, so a `messages`-only guard would
    // silently disable both the roster injection and the model fallback.
    const isChatShape = Array.isArray(body?.messages)
    const isResponsesShape = !isChatShape && Array.isArray(body?.input)
    if (!isChatShape && !isResponsesShape) return
    const shape = isResponsesShape ? "responses" : "chat"
    const tuning = typeof getAgentRequestBody === "function" ? getAgentRequestBody(input.agent) : undefined
    const tuningPayload = applyAgentTuning(body, tuning, shape)
    if (tuningPayload) {
      input.request = new Request(input.request, { body: JSON.stringify(body) })
      onAgentTuningApplied?.({
        agent: input.agent,
        providerID: input.model?.providerID ?? input.model?.provider,
        shape,
        payload: tuningPayload,
      })
    }
    const sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined
    // Proactive model fallback runs before the root/child guard. The payload
    // `model` is a bare id (no provider prefix) at this boundary, while
    // `input.model` is the V2 ref that names the provider V2 already selected.
    // Pass that provider so the resolver can only return a rung on the same
    // provider: rewriting `body.model` across providers would send the id down
    // the already-selected route (a misroute, not a fallback). When the active
    // provider is unknown, skip the walk entirely and leave `body.model` alone.
    const activeProviderID = typeof input.model?.providerID === "string" && input.model.providerID
      ? input.model.providerID
      : (typeof input.model?.provider === "string" && input.model.provider ? input.model.provider : undefined)
    if (typeof resolveModel === "function" && activeProviderID && typeof body.model === "string" && body.model.trim()) {
      let resolved
      try {
        resolved = await resolveModel({ sessionID, agent: input.agent, model: body.model, sameProviderAs: activeProviderID })
      } catch (error) {
        resolved = undefined
        console.error(`[oh-my-rigel] Native V2 model resolution failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (resolved && typeof resolved.id === "string" && resolved.id && resolved.id !== body.model) {
        body.model = resolved.id
        input.request = new Request(input.request, { body: JSON.stringify(body) })
      }
    }
    const initialDirectoryGuidance = sessionID && typeof getInitialDirectoryInstructions === "function"
      ? getInitialDirectoryInstructions({ sessionID, agent: input.agent })
      : ""
    let agents
    try { agents = await getDelegationRoster() } catch {
      onDelegationRoster?.({ count: 0, available: false })
      return
    }
    const isRoot = await isRootSession(input, agents)
    // Per-read directory context is appended to the read tool result by the
    // directory injector, not injected here; only the Hephaestus root-AGENTS
    // guidance remains a system-level injection.
    if (!isRoot) return
    const explicitUltrawork = isChatShape ? hasUltraworkKeyword(body.messages) : responsesHasUltraworkKeyword(body)
    if (sessionID && (defaultUltrawork || explicitUltrawork)) ultraworkSessions.add(sessionID)
    const ultraworkActive = defaultUltrawork || explicitUltrawork || Boolean(sessionID && ultraworkSessions.has(sessionID))
    const roster = formatDelegationRoster(agents, categories)
    onDelegationRoster?.({ count: Array.isArray(agents) ? agents.length : 0, available: Boolean(roster) })
    const injections = []
    if (initialDirectoryGuidance) injections.push(initialDirectoryGuidance)
    if (ultraworkActive && ultraworkPrompt.trim()) injections.push(ultraworkPrompt)
    if (roster) injections.push(roster)
    // V1's category-skill reminder is injected once per session at the system
    // boundary. It is consumed on the same pass so a repeated request never
    // duplicates it.
    const categorySkillReminder = sessionID && typeof getCategorySkillReminder === "function"
      ? getCategorySkillReminder(sessionID)
      : ""
    if (categorySkillReminder) injections.push(categorySkillReminder)
    if (isChatShape) {
      const messages = body.messages.filter((message) => !isRosterMessage(message) && !isUltraworkMessage(message) && !isDirectoryInstructionMessage(message))
      if (injections.length > 0) {
        const insertionIndex = messages.findIndex((message) => message?.role !== "system")
        messages.splice(insertionIndex < 0 ? messages.length : insertionIndex, 0, ...injections.map((content) => ({ role: "system", content })))
      }
      body.messages = messages
    } else {
      // Responses: the roster, the Hephaestus root-AGENTS guidance, the ultrawork
      // directive, and the category-skill reminder are all system-level text, so
      // they merge into `instructions`. `input` is left untouched.
      body.instructions = mergeInstructions(body.instructions, injections)
    }
    input.request = new Request(input.request, { body: JSON.stringify(body) })
    if (categorySkillReminder) onCategorySkillReminderConsumed?.(sessionID)
  }
}

function isRosterMessage(message) {
  return message?.role === "system"
    && typeof message.content === "string"
    && message.content.includes(ROSTER_MARKER)
}
