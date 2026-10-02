import { isDirectoryInstructionMessage } from "./rigel-v2-directory-instructions.mjs"

const CHILD_TASK_MARKER = "<rigel-native-child-task>"
const ROSTER_MARKER = "<rigel-native-delegation-roster>"
const ULTRAWORK_MARKER = "<ultrawork-mode>"
const ULTRAWORK_KEYWORD = /\b(?:ultraworker|ultrawork|ulw)\b/i

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

export function formatDelegationRoster(agents, categories = []) {
  const rows = Array.isArray(agents)
    ? agents
      .filter((agent) => agent?.mode === "subagent" || agent?.mode === "all")
      .map((agent) => safeSingleLine(agent?.name))
      .filter(Boolean)
      .map((name) => `- ${JSON.stringify(name)}: ${agentPurpose(name)}`)
    : []
  const categoryRows = Array.isArray(categories)
    ? categories.map((name) => safeSingleLine(name)).filter(Boolean).map((name) => `- ${JSON.stringify(name)}`)
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
 * V2.0.22 exposes prompt/context hooks, but their mutations do not reach the
 * provider. The HTTP request hook does. Keep roster injection here, at that
 * verified boundary, so every provider request reads the live inventory.
 */
export function createNativeRequestHook({
  getDelegationRoster,
  categories = [],
  isRootSession = async () => true,
  onDelegationRoster,
  ultraworkPrompt = "",
  defaultUltrawork = false,
  getDirectoryInstructions,
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
    if (!Array.isArray(body?.messages)) return
    const sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined
    const directoryGuidance = sessionID && typeof getDirectoryInstructions === "function"
      ? getDirectoryInstructions(sessionID)
      : ""
    let agents
    try { agents = await getDelegationRoster() } catch {
      onDelegationRoster?.({ count: 0, available: false })
      return
    }
    const isRoot = await isRootSession(input, agents)
    if (!isRoot && !directoryGuidance) return
    if (!isRoot) {
      const messages = body.messages.filter((message) => !isDirectoryInstructionMessage(message))
      const index = messages.findIndex((message) => message?.role !== "system")
      messages.splice(index < 0 ? messages.length : index, 0, { role: "system", content: directoryGuidance })
      body.messages = messages
      input.request = new Request(input.request, { body: JSON.stringify(body) })
      return
    }
    const explicitUltrawork = hasUltraworkKeyword(body.messages)
    if (sessionID && (defaultUltrawork || explicitUltrawork)) ultraworkSessions.add(sessionID)
    const ultraworkActive = defaultUltrawork || explicitUltrawork || Boolean(sessionID && ultraworkSessions.has(sessionID))
    const roster = formatDelegationRoster(agents, categories)
    onDelegationRoster?.({ count: Array.isArray(agents) ? agents.length : 0, available: Boolean(roster) })
    const messages = body.messages.filter((message) => !isRosterMessage(message) && !isUltraworkMessage(message) && !isDirectoryInstructionMessage(message))
    const injections = []
    if (directoryGuidance) injections.push({ role: "system", content: directoryGuidance })
    if (ultraworkActive && ultraworkPrompt.trim()) injections.push({ role: "system", content: ultraworkPrompt })
    if (roster) injections.push({ role: "system", content: roster })
    if (injections.length > 0) {
      const insertionIndex = messages.findIndex((message) => message?.role !== "system")
      messages.splice(insertionIndex < 0 ? messages.length : insertionIndex, 0, ...injections)
    }
    body.messages = messages
    input.request = new Request(input.request, { body: JSON.stringify(body) })
  }
}

function isRosterMessage(message) {
  return message?.role === "system"
    && typeof message.content === "string"
    && message.content.includes(ROSTER_MARKER)
}
