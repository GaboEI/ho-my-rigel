// Native OpenCode V2 port of the V1 agent-usage-reminder hook (hook.ts +
// constants.ts + storage.ts + types.ts), plus the native task-tracking reminder
// that this runtime already exposed. Production dependencies: none (the staged
// runtime is a flat tree with no node_modules).

const ORCHESTRATOR_AGENTS = new Set([
  "sisyphus",
  "sisyphus-junior",
  "atlas",
  "hephaestus",
  "prometheus",
])

// Tool names normalized to lowercase for case-insensitive matching, exactly as
// V1 constants.ts declares them.
const TARGET_TOOLS = new Set([
  "grep",
  "safe_grep",
  "glob",
  "safe_glob",
  "webfetch",
  "context7_resolve-library-id",
  "context7_query-docs",
  "websearch_web_search_exa",
  "grep_app_searchgithub",
])

// V1 AGENT_TOOLS plus the native V2 delegation name (rigel_task).
const AGENT_TOOLS = new Set(["task", "call_omo_agent", "rigel_task"])

const TASK_TOOLS = new Set([
  "task",
  "task_create",
  "task_list",
  "task_get",
  "task_update",
  "task_delete",
  "rigel_task",
])

const MAX_REMINDERS = 3
const TASK_REMINDER_THRESHOLD = 10

// Byte-exact copy of V1 constants.ts REMINDER_MESSAGE. Leading and trailing
// newlines are part of the contract.
const AGENT_USAGE_MESSAGE = `
[Agent Usage Reminder]

You called a search/fetch tool directly without leveraging specialized agents.

RECOMMENDED: Use task with explore/librarian agents for better results:

\`\`\`
// Parallel exploration - fire multiple agents simultaneously
task(subagent_type="explore", load_skills=[], prompt="Find all files matching pattern X")
task(subagent_type="explore", load_skills=[], prompt="Search for implementation of Y")
task(subagent_type="librarian", load_skills=[], prompt="Lookup documentation for Z")

// Then continue your work while they run in background
// System will notify you when each completes
\`\`\`

WHY:
- Agents can perform deeper, more thorough searches
- Background tasks run in parallel, saving time
- Specialized agents have domain expertise
- Reduces context window usage in main session

ALWAYS prefer: Multiple parallel task calls > Direct tool calls
`

const TASK_REMINDER_MESSAGE = `

The task tools have not been used recently. If work needs tracking, use the available task/goal mechanism to record progress.`

// V2 storage namespace, following the rigel-v2/<domain> convention used by the
// session-todo store.
const STORAGE_PREFIX = "rigel-v2/agent-usage-reminder"

// --- getAgentConfigKey equivalent (ported from shared/agent-display-names.ts).
// Kept local because the flat runtime must not import plugin source modules.

const AGENT_DISPLAY_NAMES = {
  sisyphus: "Sisyphus - ultraworker",
  hephaestus: "Hephaestus - Deep Agent",
  prometheus: "Prometheus - Plan Builder",
  atlas: "Atlas - Plan Executor",
  "sisyphus-junior": "Sisyphus-Junior",
  metis: "Metis - Plan Consultant",
  momus: "Momus - Plan Critic",
  athena: "Athena - Council",
  "athena-junior": "Athena-Junior - Council",
  oracle: "oracle",
  librarian: "librarian",
  explore: "explore",
  "multimodal-looker": "multimodal-looker",
  "council-member": "council-member",
}

const REVERSE_DISPLAY_NAMES = Object.fromEntries(
  Object.entries(AGENT_DISPLAY_NAMES).map(([key, displayName]) => [displayName.toLowerCase(), key]),
)

const LEGACY_DISPLAY_NAMES = {
  "sisyphus (ultraworker)": "sisyphus",
  "hephaestus (deep agent)": "hephaestus",
  "prometheus (plan builder)": "prometheus",
  "atlas (plan executor)": "atlas",
  "metis (plan consultant)": "metis",
  "momus (plan critic)": "momus",
  "athena (council)": "athena",
  "athena-junior (council)": "athena-junior",
}

const INVISIBLE_AGENT_CHARACTERS_REGEX = /[\u200B\u200C\u200D\uFEFF]/g
const VISIBLE_AGENT_LIST_SORT_PREFIX_REGEX = /^\d+\|/
const AGENT_WRAPPER_CHARS_REGEX = /^[\\/"']+|[\\/"']+$/g

function stripAgentName(agentName) {
  return String(agentName)
    .replace(INVISIBLE_AGENT_CHARACTERS_REGEX, "")
    .replace(VISIBLE_AGENT_LIST_SORT_PREFIX_REGEX, "")
    .replace(AGENT_WRAPPER_CHARS_REGEX, "")
    .trim()
    .toLowerCase()
}

function resolveAgentConfigKey(agentName) {
  const lower = stripAgentName(agentName)
  const reversed = REVERSE_DISPLAY_NAMES[lower]
  if (reversed !== undefined) return reversed
  const legacy = LEGACY_DISPLAY_NAMES[lower]
  if (legacy !== undefined) return legacy
  if (AGENT_DISPLAY_NAMES[lower] !== undefined) return lower
  return lower
}

function isOrchestratorAgent(agentName) {
  if (typeof agentName !== "string" || agentName.length === 0) return false
  return ORCHESTRATOR_AGENTS.has(resolveAgentConfigKey(agentName))
}

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

function resolveEventSessionID(event) {
  const data = event?.data
  const session = data?.session
  if (typeof data?.sessionID === "string" && data.sessionID) return data.sessionID
  if (typeof session?.id === "string" && session.id) return session.id
  if (typeof event?.properties?.sessionID === "string" && event.properties.sessionID) {
    return event.properties.sessionID
  }
  return undefined
}

function historyKey(sessionID) {
  return `${STORAGE_PREFIX}/${sessionID}`
}

function freshState(sessionID) {
  return {
    sessionID,
    agentUsed: false,
    reminderCount: 0,
    updatedAt: Date.now(),
    taskToolCount: 0,
  }
}

/**
 * V1-equivalent persistent state via an injected storage with async
 * get(key)/set(key, value). When storage is absent the module degrades to
 * in-memory only and never throws. A session's state is cleared only on
 * session deletion (V1 pinned that compaction must not reset it).
 */
export function createNativeToolResultReminders({ storage } = {}) {
  const sessionStates = new Map()
  const stateLoads = new Map()
  const storageAvailable = Boolean(storage)
    && typeof storage.get === "function"
    && typeof storage.set === "function"

  async function loadState(sessionID) {
    let persisted = null
    if (storageAvailable) {
      try {
        const value = await storage.get(historyKey(sessionID))
        if (value && typeof value === "object") persisted = value
      } catch (error) {
        void error
      }
    }
    if (!persisted) return freshState(sessionID)
    return {
      sessionID,
      agentUsed: persisted.agentUsed === true,
      reminderCount: typeof persisted.reminderCount === "number" && persisted.reminderCount >= 0
        ? persisted.reminderCount
        : 0,
      updatedAt: typeof persisted.updatedAt === "number" ? persisted.updatedAt : Date.now(),
      taskToolCount: 0,
    }
  }

  function ensureState(sessionID) {
    const existing = sessionStates.get(sessionID)
    if (existing) return Promise.resolve(existing)
    let loading = stateLoads.get(sessionID)
    if (!loading) {
      loading = loadState(sessionID).then((state) => {
        sessionStates.set(sessionID, state)
        stateLoads.delete(sessionID)
        return state
      })
      stateLoads.set(sessionID, loading)
    }
    return loading
  }

  async function persist(state) {
    if (!storageAvailable) return
    try {
      await storage.set(historyKey(state.sessionID), {
        sessionID: state.sessionID,
        agentUsed: state.agentUsed,
        reminderCount: state.reminderCount,
        updatedAt: state.updatedAt,
      })
    } catch (error) {
      void error
    }
  }

  async function resetPersisted(sessionID) {
    if (!storageAvailable) return
    try {
      if (typeof storage.delete === "function") {
        await storage.delete(historyKey(sessionID))
      } else {
        await storage.set(historyKey(sessionID), null)
      }
    } catch (error) {
      void error
    }
  }

  function clear(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) return Promise.resolve()
    sessionStates.delete(sessionID)
    stateLoads.delete(sessionID)
    return resetPersisted(sessionID)
  }

  function clearAll() {
    // Teardown must not wipe persisted state: surviving a restart is the point
    // of the storage port. Only the live instance's memory is dropped.
    sessionStates.clear()
    stateLoads.clear()
  }

  async function after(event) {
    if (event && event.type === "session.deleted") {
      const deleted = resolveEventSessionID(event)
      if (deleted) await clear(deleted)
      return false
    }
    if (!event || event.status !== "completed" || typeof event.sessionID !== "string" || !event.sessionID) {
      return false
    }

    const sessionID = event.sessionID
    const state = await ensureState(sessionID)
    const tool = String(event.tool ?? "").toLowerCase()
    let appended = false

    // Agent-usage branch, V1 semantics: a known non-orchestrator session is
    // skipped entirely; an unknown agent proceeds as eligible.
    const agent = event.agent
    const agentEligible = typeof agent !== "string" || agent.length === 0 || isOrchestratorAgent(agent)
    if (agentEligible) {
      if (AGENT_TOOLS.has(tool)) {
        if (!state.agentUsed) {
          state.agentUsed = true
          state.updatedAt = Date.now()
          await persist(state)
        }
      } else if (TARGET_TOOLS.has(tool) && !state.agentUsed && state.reminderCount < MAX_REMINDERS) {
        if (appendResultText(event.result, AGENT_USAGE_MESSAGE)) {
          state.reminderCount += 1
          state.updatedAt = Date.now()
          await persist(state)
          appended = true
        }
      }
    }

    // Native task-tracking reminder (10 non-task tools), preserved from the
    // previous runtime behavior.
    if (TASK_TOOLS.has(tool)) state.taskToolCount = 0
    else state.taskToolCount += 1
    if (!TASK_TOOLS.has(tool) && state.taskToolCount >= TASK_REMINDER_THRESHOLD) {
      if (appendResultText(event.result, TASK_REMINDER_MESSAGE)) {
        state.taskToolCount = 0
        appended = true
      }
    }

    return appended
  }

  return { after, clear, clearAll }
}
