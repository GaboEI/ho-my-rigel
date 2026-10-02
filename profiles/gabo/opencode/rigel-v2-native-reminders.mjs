const AGENT_USAGE_TARGETS = new Set([
  "grep", "safe_grep", "glob", "safe_glob", "webfetch", "context7_resolve-library-id",
  "context7_query-docs", "websearch_web_search_exa", "grep_app_searchgithub",
])
const DELEGATION_TOOLS = new Set(["rigel_task", "task", "call_omo_agent"])
const TASK_TOOLS = new Set(["task", "task_create", "task_list", "task_get", "task_update", "task_delete", "rigel_task"])
const ORCHESTRATOR = /(?:sisyphus|atlas|hephaestus|prometheus)/i
const MAX_AGENT_USAGE_REMINDERS = 3
const TASK_REMINDER_THRESHOLD = 10

const AGENT_USAGE_MESSAGE = `
[Agent Usage Reminder]

You called a search/fetch tool directly without leveraging a specialized agent. Prefer parallel \`rigel_task\` calls to \`explore\` or \`librarian\` when the work can be delegated.`

const TASK_REMINDER_MESSAGE = `

The task tools have not been used recently. If work needs tracking, use the available task/goal mechanism to record progress.`

function appendResultText(result, text) {
  if (!result || typeof result !== "object") return false
  if (typeof result.content === "string") {
    result.content += text
    return true
  }
  if (Array.isArray(result.content)) {
    result.content.push({ type: "text", text })
    return true
  }
  return false
}

function isOrchestrator(agent) {
  return typeof agent === "string" && ORCHESTRATOR.test(agent)
}

/**
 * Native V2 replacement for the V1 agent-usage and task-reminder hooks.
 * V2's post-execution event is mutable and therefore preserves the original
 * model-visible reminder placement without replacing the user prompt.
 */
export function createNativeToolResultReminders() {
  const state = new Map()
  const forSession = (sessionID) => {
    if (!state.has(sessionID)) state.set(sessionID, { agentUsed: false, agentReminders: 0, taskToolCount: 0 })
    return state.get(sessionID)
  }

  return {
    after(event) {
      if (event?.status !== "completed" || typeof event.sessionID !== "string") return
      const tool = String(event.tool ?? "").toLowerCase()
      const session = forSession(event.sessionID)

      if (DELEGATION_TOOLS.has(tool)) session.agentUsed = true
      if (TASK_TOOLS.has(tool)) session.taskToolCount = 0
      else session.taskToolCount += 1

      if (isOrchestrator(event.agent) && AGENT_USAGE_TARGETS.has(tool) && !session.agentUsed && session.agentReminders < MAX_AGENT_USAGE_REMINDERS) {
        if (appendResultText(event.result, AGENT_USAGE_MESSAGE)) session.agentReminders += 1
      }
      if (!TASK_TOOLS.has(tool) && session.taskToolCount >= TASK_REMINDER_THRESHOLD) {
        if (appendResultText(event.result, TASK_REMINDER_MESSAGE)) session.taskToolCount = 0
      }
    },
    clear(sessionID) {
      if (typeof sessionID === "string") state.delete(sessionID)
    },
    clearAll() { state.clear() },
  }
}
