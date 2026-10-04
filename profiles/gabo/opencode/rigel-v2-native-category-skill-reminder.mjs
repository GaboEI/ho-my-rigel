/**
 * Native OpenCode V2 port of the V1 category-skill-reminder hook.
 *
 * V1 owner: packages/omo-opencode/src/hooks/category-skill-reminder/
 *   hook.ts      - target agents, 3-delegatable-tool threshold, once/session,
 *                  delegation suppression, session-deletion clear
 *   formatter.ts - byte-exact reminder message built from the available skills
 *
 * V1 injects the reminder by splicing a synthetic text part into the latest
 * user turn inside `experimental.chat.messages.transform`. The native V2
 * runtime has no such transform boundary for this hook, so this module splits
 * the two concerns: `after(event)` observes `tool.execute.after` and records
 * state, while the runtime reads `pending(sessionID)` at the `http.request`
 * boundary and calls `consume(sessionID)` once it has injected the block into
 * the root orchestrator's system instructions.
 *
 * `after` never mutates the tool output. State is in-memory and per session.
 * `clear(sessionID)` is the only reset and is called on `session.deleted`; a
 * `session.compacted` must NOT reset this state, so this module exposes no
 * compaction handler.
 */

const TARGET_AGENTS = new Set([
  "sisyphus",
  "sisyphus-junior",
  "atlas",
])

const DELEGATABLE_WORK_TOOLS = new Set([
  "edit",
  "write",
  "bash",
  "read",
  "grep",
  "glob",
])

const DELEGATION_TOOLS = new Set([
  "task",
  "call_omo_agent",
  "rigel_task",
])

const BUILTIN_LOCATIONS = new Set(["plugin", "builtin"])

const DELEGATABLE_WORK_THRESHOLD = 3
const SKILL_NAME_LIMIT = 8

const INVISIBLE_AGENT_CHARACTERS = /[\u200B\u200C\u200D\uFEFF]/g
const AGENT_LIST_SORT_PREFIX = /^\d+\|/
const AGENT_WRAPPER_CHARACTERS = /^[\\/"']+|[\\/"']+$/g
const AGENT_DISPLAY_SUFFIX = /\s+-\s+/

/**
 * Resolve an agent display name or id to its config key the way V1's
 * `getAgentConfigKey` does: drop invisible characters, drop a leading list
 * sort prefix such as `3|`, drop surrounding wrapper quotes/slashes, lowercase,
 * and drop a trailing ` - ...` UI suffix ("Sisyphus - ultraworker" -> "sisyphus",
 * "sisyphus-junior" -> "sisyphus-junior", "Atlas - Plan Executor" -> "atlas").
 */
export function canonicalAgentKey(agent) {
  if (typeof agent !== "string") return ""
  const normalized = agent
    .replace(INVISIBLE_AGENT_CHARACTERS, "")
    .replace(AGENT_LIST_SORT_PREFIX, "")
    .replace(AGENT_WRAPPER_CHARACTERS, "")
    .trim()
    .toLowerCase()
  return normalized.split(AGENT_DISPLAY_SUFFIX)[0].trim()
}

function skillName(skill) {
  return typeof skill?.name === "string" ? skill.name : undefined
}

function isBuiltinSkill(skill) {
  const location = typeof skill?.location === "string" ? skill.location.toLowerCase() : undefined
  const source = typeof skill?.source === "string" ? skill.source.toLowerCase() : undefined
  return BUILTIN_LOCATIONS.has(location) || BUILTIN_LOCATIONS.has(source)
}

function formatSkillNames(skills, limit) {
  const names = skills.map(skillName).filter((name) => typeof name === "string" && name.length > 0)
  if (names.length === 0) return "(none)"
  const shown = names.slice(0, limit)
  const remaining = names.length - shown.length
  const suffix = remaining > 0 ? ` (+${remaining} more)` : ""
  return shown.join(", ") + suffix
}

/** Byte-exact formatter ported from V1 `formatter.ts`. */
export function buildCategorySkillReminderMessage(availableSkills) {
  const skills = Array.isArray(availableSkills) ? availableSkills.filter((skill) => skill && typeof skill === "object") : []
  const builtinSkills = skills.filter((skill) => isBuiltinSkill(skill))
  const customSkills = skills.filter((skill) => !isBuiltinSkill(skill))

  const builtinText = formatSkillNames(builtinSkills, SKILL_NAME_LIMIT)
  const customText = formatSkillNames(customSkills, SKILL_NAME_LIMIT)

  const exampleSkillName = skillName(customSkills[0]) ?? skillName(builtinSkills[0])
  const loadSkills = exampleSkillName ? `["${exampleSkillName}"]` : "[]"

  const lines = [
    "",
    "[Category+Skill Reminder]",
    "",
    `**Built-in**: ${builtinText}`,
    `**⚡ YOUR SKILLS (PRIORITY)**: ${customText}`,
    "",
    "> User-installed skills OVERRIDE built-in defaults. ALWAYS prefer YOUR SKILLS when domain matches.",
    "",
    "```typescript",
    `task(category=\"visual-engineering\", load_skills=${loadSkills}, run_in_background=true)`,
    "```",
    "",
  ]

  return lines.join("\n")
}

function createSessionState() {
  return {
    delegationUsed: false,
    reminderPending: false,
    reminderShown: false,
    toolCallCount: 0,
  }
}

/**
 * Build the native category-skill reminder.
 *
 * @param {object} [deps]
 * @param {() => Array<{name?: string, location?: string, source?: string}>} [deps.getSkills]
 *   Available skills, read once at construction to build the byte-exact message.
 * @param {(input: {sessionID?: string, agent?: string}) => (string|undefined|Promise<string|undefined>)} [deps.getAgent]
 *   Resolve the session's agent (may be sync or async). Falls back to the
 *   inline `event.agent` when it returns nothing.
 */
export function createNativeCategorySkillReminder({ getSkills, getAgent } = {}) {
  const sessions = new Map()
  const initialSkills = typeof getSkills === "function" ? getSkills() : []
  const reminder = buildCategorySkillReminderMessage(Array.isArray(initialSkills) ? initialSkills : [])

  function stateFor(sessionID) {
    if (!sessions.has(sessionID)) sessions.set(sessionID, createSessionState())
    return sessions.get(sessionID)
  }

  async function resolveAgentKey(sessionID, inlineAgent) {
    const resolved = typeof getAgent === "function"
      ? await getAgent({ sessionID, agent: inlineAgent })
      : undefined
    const agent = resolved ?? inlineAgent
    const key = canonicalAgentKey(agent)
    return TARGET_AGENTS.has(key) ? key : undefined
  }

  return {
    /**
     * Observe a completed tool call. Target-agent delegatable work increments a
     * counter; the third call with no delegation and no prior reminder queues the
     * pending block. Delegation marks the session permanently suppressed. The
     * tool output is never touched.
     */
    async after(event) {
      if (!event || typeof event !== "object") return
      const sessionID = event.sessionID
      const tool = typeof event.tool === "string" ? event.tool.toLowerCase() : ""
      if (typeof sessionID !== "string" || sessionID.length === 0) return

      const targetKey = await resolveAgentKey(sessionID, event.agent)
      if (!targetKey) return

      const state = stateFor(sessionID)

      if (DELEGATION_TOOLS.has(tool)) {
        state.delegationUsed = true
        state.reminderPending = false
        return
      }

      if (!DELEGATABLE_WORK_TOOLS.has(tool)) return

      state.toolCallCount += 1

      if (
        state.toolCallCount >= DELEGATABLE_WORK_THRESHOLD
        && !state.delegationUsed
        && !state.reminderPending
        && !state.reminderShown
      ) {
        state.reminderPending = true
      }
    },

    /**
     * The reminder block to inject at the `http.request` boundary, or "" when
     * nothing is pending. Pending requires an armed reminder that was neither
     * shown nor suppressed by delegation.
     */
    pending(sessionID) {
      const state = sessions.get(sessionID)
      if (!state || !state.reminderPending || state.reminderShown || state.delegationUsed) return ""
      return reminder
    },

    /**
     * Mark the session's reminder shown and clear pending (at most once per
     * session). Returns the consumed block so a caller can inject it in the same
     * step, or "" when there was nothing to consume.
     */
    consume(sessionID) {
      const state = sessions.get(sessionID)
      if (!state || !state.reminderPending || state.reminderShown || state.delegationUsed) return ""
      state.reminderPending = false
      state.reminderShown = true
      return reminder
    },

    /** Drop a session's state. Called on `session.deleted`, not on compaction. */
    clear(sessionID) {
      if (typeof sessionID === "string") sessions.delete(sessionID)
    },

    clearAll() {
      sessions.clear()
    },
  }
}
