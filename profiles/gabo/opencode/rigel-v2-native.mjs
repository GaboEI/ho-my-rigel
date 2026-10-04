import {
  delegateNamedAgentFromClients,
  listCallableAgentsFromClients,
  resolveNamedAgent,
  taskResult,
  resumeDelegatedSessionFromClients,
  completedChildText,
  backgroundHandoffPrompt,
  isCoordinatorAgent,
  normalizeToolDefinition,
} from "./rigel-v2-native-core.mjs"
import {
  categoryTaskPrompt,
  listV2ModelsFromClients,
  mergeCategories,
  resolveCategoryFromClients,
} from "./rigel-v2-native-categories.mjs"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createNativeRequestHook } from "./rigel-v2-native-prompt.mjs"
import { agentChain, categoryChain, resolveFallbackModel } from "./rigel-v2-native-model-chains.mjs"
import { createDirectoryInstructionStore } from "./rigel-v2-directory-instructions.mjs"
import { createNativeToolResultReminders } from "./rigel-v2-native-reminders.mjs"
import { applyNativeRecoveryReminder } from "./rigel-v2-native-recovery.mjs"
import { createNativeRulesInjector } from "./rigel-v2-native-rules.mjs"
import { createNativeWriteExistingFileGuard } from "./rigel-v2-native-write-guard.mjs"
import { createNativeNonInteractiveEnvGuard } from "./rigel-v2-native-noninteractive.mjs"
import manifest from "./rigel-v2-native-agent-manifest.mjs"
import { readNativeDisabled, readNativeGates } from "./rigel-v2-native-config.mjs"
import { registerNativeAgents } from "./rigel-v2-native-agents.mjs"
import { createNativeToolPermissionGate, translateGlobalTools } from "./rigel-v2-native-permissions.mjs"
import { registerNativeSkills, selectSkillsForChild, formatSkillInjection } from "./rigel-v2-native-skills.mjs"
import { createSkillMcpManager, createSkillMcpToolDefinition, registerSkillMcpServers } from "./rigel-v2-native-skill-mcp.mjs"
import { createNativeToolFamilies } from "./rigel-v2-native-tools.mjs"
import { registerConditionalNativeTools } from "./rigel-v2-native-conditional-tools.mjs"
import { createV2SessionTodoStore, createTaskTodoSync } from "./tools/session-todo-store.mjs"
import { createServerApi } from "./rigel-v2-native-http.mjs"
import { createPersistentTerminalPort } from "./tools/terminal-driver.mjs"

/**
 * Read the user's category overrides from the V2 setup context. V2 exposes the
 * merged plugin configuration on `context.config`; the shape is the same
 * `pluginConfig.categories` V1 reads (`packages/omo-opencode/src/plugin-handlers/agent-config-assembly.ts`).
 * A missing or malformed value degrades to no overrides so setup never fails
 * closed on a config read.
 */
export function readUserCategories(context) {
  const config = context?.config
  const categories = config?.categories
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) return undefined
  return categories
}

/**
 * Build the category roster the orchestrator prompt receives. Each entry
 * carries the name plus the description and caller guidance the resolved
 * category owns, so the roster is selection data rather than a names-only list.
 * The built-in manifest supplies the text; a user override replaces it.
 */
export function buildCategoryRoster(userCategories) {
  const enabled = mergeCategories(userCategories)
  const descriptions = manifest.descriptions ?? {}
  const guidance = manifest.guidance ?? {}
  return Object.entries(enabled).map(([name]) => ({
    name,
    description: userCategories?.[name]?.description ?? descriptions[name],
    callerGuidance: userCategories?.[name]?.caller_guidance ?? guidance[name],
  }))
}

/**
 * Skill-injection integration point for delegated children.
 *
 * The real resolver is Task 14 (`rigel-v2-native-skills.mjs`), which discovers
 * SKILL.md bodies and matches them by name. Resolved skills are injected as
 * `<skill name="...">` blocks via the module's own formatter; names that do not
 * resolve (unknown, disabled, or restricted to another agent) keep the textual
 * fallback notice so the gap is visible and the child can still try to load
 * them itself.
 *
 * `resolveSkill` is `(name) => Promise<{ name, body } | undefined>`.
 */
export async function applyRequestedSkills(prompt, requestedSkills, { resolveSkill } = {}) {
  if (!Array.isArray(requestedSkills) || requestedSkills.length === 0) return prompt
  if (typeof resolveSkill !== "function") {
    // No resolver available: never fake an injected skill, but do not drop the
    // request either. Emit the textual fallback for the whole set.
    const notice = `<rigel-requested-skills>Before working, load these native skills if available: ${requestedSkills.join(", ")}</rigel-requested-skills>`
    return `${prompt}\n\n${notice}`
  }
  const injected = []
  const missing = []
  for (const name of requestedSkills) {
    try {
      const result = await resolveSkill(name)
      if (result && typeof result.body === "string" && result.body.trim()) {
        injected.push({ name: result.name ?? name, body: result.body })
      } else {
        missing.push(name)
      }
    } catch (error) {
      missing.push(name)
      console.error(`[ho-my-rigel] Native V2 skill resolution failed: skill=${name}; ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (missing.length > 0) {
    console.error(`[ho-my-rigel] Native V2 skill injection incomplete; unresolved skills: ${missing.join(", ")}`)
  }
  const injection = formatSkillInjection({ injected, missing })
  return injection ? `${prompt}\n\n${injection}` : prompt
}

function writeStateReceipt(fileName, event) {
  const stateRoot = process.env.XDG_STATE_HOME
  if (!stateRoot) return
  const directory = path.join(stateRoot, "ho-my-rigel")
  const receipt = path.join(directory, fileName)
  const temporary = `${receipt}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporary, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...event }, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, receipt)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch (cleanupError) {
      console.error(`[ho-my-rigel] Could not remove incomplete native V2 receipt: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    }
    console.error(`[ho-my-rigel] Could not record native V2 receipt ${fileName}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function recordAgentTuning(event) {
  writeStateReceipt("agent-tuning-applied.json", event)
}

function recordConditionalToolRegistration(event) {
  writeStateReceipt("conditional-tools-registered.json", event)
}

function recordNativeToolFamilies(event) {
  writeStateReceipt("native-tool-families-registered.json", event)
}

export function createTaskPresentation() {
  return `Spawn one delegated task through the OpenCode V2 agent runtime.

⚠️ CRITICAL: provide exactly one of category, subagent_type, or task_id. A task_id resumes a prior Rigel child.

Use subagent_type for a named specialist when its role matches a discrete research, consultation, review, or audit need. Use category for an execution worker with a category-selected model. The main agent chooses the appropriate route based on the active V2 agent inventory; this tool does not impose a routing policy.

By default this is foreground work: it waits and returns the child's final text, so use it when the result is needed for the next decision. Set run_in_background=true for independent work: it returns immediately, then native V2 event delivery wakes the parent with the child's final result. Prompts must state the child task, scope, constraints, and expected evidence clearly.`
}

// V2 accepts a JSON Schema/Standard Schema/Effect codec. A raw V1 Zod shape
// becomes `unknown` to the model, which silently produces V1 argument names.
const taskInput = {
  type: "object",
  properties: {
    subagent_type: { type: "string", description: "Exact callable agent name; omit when category or task_id is supplied." },
    category: { type: "string", description: "OmO category; omit when subagent_type or task_id is supplied." },
    task_id: { type: "string", description: "Existing Rigel child session ID to continue; omit for a new child." },
    description: { type: "string", description: "Short task description." },
    prompt: { type: "string", description: "Full task for the child agent." },
    run_in_background: { type: "boolean", description: "Set true only for independent work. Default false waits and returns the child result." },
    load_skills: { type: "array", items: { type: "string" }, description: "Skills the child should load before working." },
  },
  required: ["prompt"],
  additionalProperties: false,
  anyOf: [{ required: ["subagent_type"] }, { required: ["category"] }, { required: ["task_id"] }],
}

function readSessionAgent(result) {
  const agent = result?.data?.agent ?? result?.agent
  if (typeof agent !== "string") return undefined
  const trimmed = agent.trim()
  return trimmed ? trimmed : undefined
}

async function lookupSessionAgent(call, sessionID) {
  try {
    return readSessionAgent(await call())
  } catch (error) {
    console.error(`[ho-my-rigel] Native V2 session agent lookup failed: session=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Resolve the agent that owns a V2 session, for the tool-name permission gate
 * when `tool.execute.before` carries no `agent`. Uses the V2 session surface
 * first and the compatible client surface second; an absent or failing lookup
 * returns `undefined` so the gate can decide whether to fail closed.
 */
export function createSessionAgentResolver(context) {
  return async ({ sessionID } = {}) => {
    if (typeof sessionID !== "string" || !sessionID) return undefined
    if (typeof context?.session?.get === "function") {
      const fromSession = await lookupSessionAgent(() => context.session.get({ sessionID }), sessionID)
      if (fromSession) return fromSession
    }
    if (typeof context?.client?.session?.get === "function") {
      return lookupSessionAgent(() => context.client.session.get({ path: { id: sessionID } }), sessionID)
    }
    return undefined
  }
}

/**
 * Build the tool-name permission gate the runtime wires as one
 * `tool.execute.before` hook. It merges the materialized global
 * `manifest.metadata.global.tools` gates before each agent's gates (so an
 * agent-specific declaration wins) and indexes every agent under both its
 * manifest id and its display name.
 *
 * Exported so the runtime tests can drive the real collection and decision path
 * with a fixture manifest instead of mutating the generated manifest module.
 */
export function createNativePermissionWiring({ manifest: agentManifest, resolveAgent } = {}) {
  const globalGates = translateGlobalTools(agentManifest?.metadata?.global?.tools)
  const agents = agentManifest && typeof agentManifest.agents === "object" && agentManifest.agents !== null ? agentManifest.agents : {}
  const gate = createNativeToolPermissionGate({ globalGates, resolveAgent })
  return {
    globalGates,
    onAgentPermissions(id, permissions) {
      if (typeof id !== "string" || !id) return
      gate.registerAgent(id, permissions)
      const name = agents[id]?.name
      if (typeof name === "string" && name && name !== id) gate.registerAgent(name, permissions)
    },
    before(event) {
      return gate.before(event)
    },
  }
}

export default {
  id: "ho-my-rigel",
  setup: async (context) => {
    const location = context?.location ?? { directory: process.cwd() }
    if (typeof context?.tool?.transform !== "function") {
      throw new Error("OpenCode V2 tool.transform is unavailable")
    }
    const agentRequestBodies = new Map()
    // User category overrides come from the merged plugin config V2 exposes on
    // the setup context. They are read once and threaded through both the
    // execution-time resolver and the orchestrator roster so a user category is
    // selectable and routable exactly like a built-in.
    const userCategories = readUserCategories(context)
    const permissionWiring = createNativePermissionWiring({
      manifest,
      resolveAgent: createSessionAgentResolver(context),
    })
    const registeredAgents = await registerNativeAgents(context.agent, manifest, {
      // Proactive fallback runs at this pre-selection boundary: the live
      // inventory decides each agent's starting model before `agent.reload`,
      // so an agent whose primary is absent starts on the next chain rung
      // instead of being rejected by V2 before any request hook can run.
      listModels: () => listV2ModelsFromClients([context, context?.client], location),
      onAgentRequest: (id, body) => {
        agentRequestBodies.set(id.toLocaleLowerCase(), body)
        const name = manifest.agents?.[id]?.name
        if (typeof name === "string") agentRequestBodies.set(name.toLocaleLowerCase(), body)
      },
      // The permission gate consumes each agent's translated tool-name gates
      // here, so the `execute.before` hook below governs the real roster.
      onAgentPermissions: (id, permissions) => permissionWiring.onAgentPermissions(id, permissions),
    })
    // Native skill surface (Task 14). Discovered skills are registered into
    // V2's own skill registry (`context.skill.transform`), and their embedded
    // MCP servers into V2's MCP registry (`context.mcp.transform`). The same
    // discovered list feeds real body injection for delegated children and the
    // per-session `skill_mcp` manager. When the host lacks a domain (older lab
    // build or a test fixture), the family degrades to an empty, inert set
    // instead of throwing during setup.
    const skillRegistry = typeof context?.skill?.transform === "function"
      ? await registerNativeSkills(context, {
        directory: location.directory,
        // Test seam: a fixture may point discovery at a disposable home/XDG pair
        // so the host's real skill inventory is never read.
        home: context?.options?.skillsHome,
        env: context?.options?.skillsEnv,
      })
      : { skills: [], registered: [], dispose: undefined }
    const skillMcpManager = createSkillMcpManager()
    const skillMcpRegistration = await registerSkillMcpServers(context, skillRegistry.skills)
    // Real skill-body injection for delegated children: resolve each requested
    // name through the discovered registry and inject the body. Disabled or
    // target-restricted names resolve to nothing and are reported, never faked.
    const resolveSkillForChild = async (name) => {
      const selected = selectSkillsForChild(skillRegistry.skills, [name])
      const match = selected.injected?.[0]
      return match ? { name: match.name, body: match.body } : undefined
    }
    const ultraworkFile = new URL("./prompts/ultrawork-default.md", import.meta.url)
    const ultraworkPrompt = fs.existsSync(ultraworkFile) ? fs.readFileSync(ultraworkFile, "utf8") : ""
    if (manifest.modes?.defaultUltrawork === true && !ultraworkPrompt.trim()) {
      throw new Error("Rigel V2 default Ultrawork is enabled but its native prompt is missing")
    }
    // V2 owns `task` after plugin transforms complete, so registering that
    // name here creates an editor entry the model never receives. A distinct
    // name is required for a real, callable Rigel delegation surface.
    const taskName = process.env.RIGEL_NATIVE_TASK_NAME || "rigel_task"
    const childSessionIDs = new Set()
    // Proactive/reactive model fallback state. Keyed by session so a failing
    // child never poisons its parent's chain, and bounded by the chain length.
    const categoryChildSessions = new Map()
    const sessionFallback = new Map()
    let inventoryFailureLogged = false
    const readAvailableModels = async () => {
      try {
        return await listV2ModelsFromClients([context, context?.client], location)
      } catch (error) {
        if (!inventoryFailureLogged) {
          inventoryFailureLogged = true
          console.error(`[ho-my-rigel] Native V2 model inventory unavailable; model fallback disabled: ${error instanceof Error ? error.message : String(error)}`)
        }
        return undefined
      }
    }
    const resolveNativeModel = async ({ sessionID, agent, model, sameProviderAs }) => {
      if (!sessionID || typeof model !== "string" || !model.trim()) return undefined
      const chain = categoryChildSessions.has(sessionID)
        ? categoryChain(categoryChildSessions.get(sessionID))
        : agentChain(agent)
      if (!Array.isArray(chain) || chain.length === 0) return undefined
      const state = sessionFallback.get(sessionID) ?? { chain, failedModels: new Set(), attempts: 0 }
      state.chain = chain
      state.model = model
      state.agent = agent
      // Remember the provider V2 selected for this session so the reactive path
      // (which has no request ref of its own) can stay on it too.
      if (typeof sameProviderAs === "string" && sameProviderAs) state.providerID = sameProviderAs
      sessionFallback.set(sessionID, state)
      // Bounded attempts: once the chain is exhausted, stop rewriting.
      if (state.attempts >= chain.length) return undefined
      // A reactive failure already selected the next step; honour it directly
      // so the rewrite does not depend on the model V2 happens to resend.
      if (state.nextModel?.id && !state.failedModels.has(state.nextModel.id)) {
        const next = state.nextModel
        state.nextModel = undefined
        if (next.id !== model) {
          console.error(`[ho-my-rigel] Native V2 model fallback (reactive step): session=${sessionID}; agent=${agent ?? "unknown"}; from=${model}; to=${next.id}; attempts=${state.attempts}/${chain.length}`)
        }
        return next
      }
      const availableModels = await readAvailableModels()
      if (!availableModels) return undefined
      const resolved = resolveFallbackModel({ chain, availableModels, currentModel: model, failedModels: state.failedModels, sameProviderAs })
      if (resolved?.id && resolved.id !== model) {
        console.error(`[ho-my-rigel] Native V2 model fallback: session=${sessionID}; agent=${agent ?? "unknown"}; from=${model}; to=${resolved.id}; attempts=${state.attempts}/${chain.length}`)
      }
      return resolved
    }
    const applyReactiveFallback = async (sessionID) => {
      const state = sessionFallback.get(sessionID)
      if (!state) return
      const chain = Array.isArray(state.chain) ? state.chain : []
      if (state.attempts >= chain.length) return
      if (typeof state.model === "string" && state.model) state.failedModels.add(state.model)
      state.attempts += 1
      if (state.attempts >= chain.length) {
        console.error(`[ho-my-rigel] Native V2 model fallback exhausted: session=${sessionID}; attempts=${state.attempts}/${chain.length}; last=${state.model ?? "unknown"}`)
        return
      }
      const availableModels = await readAvailableModels()
      // Reactive resolution walks the FULL chain and may change provider: unlike
      // `http.request` (post-selection, same-provider guard only), `switchModel`
      // is a pre-selection boundary that accepts a `providerID`, so picking a
      // rung on another provider is a real fallback here, not a misroute.
      // `sameProviderAs` is deliberately omitted for this path.
      const next = availableModels
        ? resolveFallbackModel({ chain, availableModels, currentModel: state.model, failedModels: state.failedModels })
        : undefined
      state.nextModel = next
      console.error(`[ho-my-rigel] Native V2 reactive model fallback: session=${sessionID}; failed=${state.model ?? "unknown"}; attempts=${state.attempts}/${chain.length}; next=${next?.id ?? "none"}`)
      // V2 ignores the `http.request` `body.model` rewrite (proven live), so the
      // resolved rung only takes effect through the pre-selection model boundary.
      // Switch the session model to the resolved rung, carrying its own
      // providerID so a cross-provider fallback is honoured; the next request
      // then runs the fallback. Guarded so an absent API or a provider
      // rejection never tears down the event subscription.
      if (next?.id && typeof context?.session?.switchModel === "function") {
        try {
          await context.session.switchModel({
            sessionID,
            model: {
              ...(next.providerID ? { providerID: next.providerID } : {}),
              id: next.id,
            },
          })
          // Advance the tracked model to the rung we just switched to. Without
          // this the next failure would re-add the stale model and resolve the
          // same rung again, so the walk would stall instead of advancing.
          // The new model is NOT marked failed here: it becomes the running
          // model, and the next failure marks it before the following walk.
          state.model = next.id
          if (typeof next.providerID === "string" && next.providerID) state.providerID = next.providerID
        } catch (error) {
          console.error(`[ho-my-rigel] Native V2 switchModel failed: session=${sessionID}; model=${next.id}; ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Seed a delegated child's fallback state at creation time, so a failure
    // that happens BEFORE `http.request` (an unavailable model or variant
    // rejected at V2 model resolution) still has a chain to walk. Without this,
    // `session.execution.failed` would arrive for an untracked session and the
    // reactive fallback could not act.
    const seedChildFallback = (sessionID, { agent, model } = {}) => {
      if (typeof sessionID !== "string" || !sessionID) return
      const chain = categoryChildSessions.has(sessionID)
        ? categoryChain(categoryChildSessions.get(sessionID))
        : agentChain(agent)
      if (!Array.isArray(chain) || chain.length === 0) return
      const state = sessionFallback.get(sessionID) ?? { chain, failedModels: new Set(), attempts: 0 }
      state.chain = chain
      if (typeof model?.id === "string" && model.id) state.model = model.id
      if (typeof agent === "string" && agent) state.agent = agent
      if (typeof model?.providerID === "string" && model.providerID) state.providerID = model.providerID
      sessionFallback.set(sessionID, state)
    }
    const directoryInstructions = createDirectoryInstructionStore({ directory: location.directory })
    const reminders = createNativeToolResultReminders()
    const rules = createNativeRulesInjector({ directory: location.directory })
    const writeGuard = createNativeWriteExistingFileGuard({ directory: location.directory })
    const nonInteractiveEnv = createNativeNonInteractiveEnvGuard()
    const backgroundChildren = new Map()
    const abortBackgroundHandoffs = new AbortController()
    // Session/todo surface (Fase 3 T5b). V2 has no native session-todo API, so
    // the runtime owns a per-session registry over `ctx.storage`: the task tools
    // write it through `syncTodos`, and the session_* tools read real todos from
    // it. An absent storage domain degrades to no registry (readTodos undefined)
    // rather than a fabricated empty constant.
    const sessionTodoStore = context?.storage
      && typeof context.storage.get === "function"
      && typeof context.storage.set === "function"
      ? createV2SessionTodoStore({ storage: context.storage })
      : undefined
    const readTodos = sessionTodoStore ? (sessionID) => sessionTodoStore.readTodos(sessionID) : undefined
    const taskTodoSync = sessionTodoStore ? createTaskTodoSync({ store: sessionTodoStore }) : undefined
    // Task 15: the monitor registry is created inside `tool.transform` (it needs
    // the V2 pty/storage/event domains) and disposed on teardown. It is `let`
    // because the transform callback runs after this declaration.
    let nativeToolRegistry
    const handoffBackgroundChild = async (sessionID, status) => {
      const child = backgroundChildren.get(sessionID)
      if (!child) return
      backgroundChildren.delete(sessionID)
      let result = ""
      try {
        if (status === "succeeded" && typeof context?.session?.context === "function") {
          result = completedChildText(await context.session.context({ sessionID }))
        }
        await context.session.prompt({
          sessionID: child.parentSessionID,
          text: backgroundHandoffPrompt({ sessionID, agent: child.agent, status, result }),
          resume: true,
        })
        console.error(`[ho-my-rigel] Native V2 background handoff: child=${sessionID}; parent=${child.parentSessionID}; status=${status}`)
      } catch (error) {
        backgroundChildren.set(sessionID, child)
        console.error(`[ho-my-rigel] Native V2 background handoff failed: child=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const eventSubscription = typeof context?.event?.subscribe === "function"
      ? (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: abortBackgroundHandoffs.signal })) {
            const sessionID = event?.data?.sessionID ?? event?.data?.session?.id ?? event?.properties?.sessionID
            if (event.type === "session.deleted" && typeof sessionID === "string") {
              reminders.clear(sessionID)
              rules.clear(sessionID)
              writeGuard.clear(sessionID)
              sessionFallback.delete(sessionID)
              categoryChildSessions.delete(sessionID)
              // Task 14: drop a session's embedded skill MCP clients when its
              // session is deleted, so a per-session MCP process never outlives
              // the session that spawned it.
              await skillMcpManager.disconnectSession(sessionID)
            }
            // Reactive fallback: a failed execution marks the last-sent model
            // failed for that session, so the next request resolves the next
            // reachable rung. Independent of the background-handoff wake.
            if (typeof sessionID === "string" && (event.type === "session.execution.failed" || event.type === "session.error")) {
              await applyReactiveFallback(sessionID)
            }
            // Task 15: a monitor's PTY exit is observed here so its record
            // transitions to `exited` without polling. The registry is created
            // later in `tool.transform`; guard for the pre-registration window.
            if (nativeToolRegistry && typeof nativeToolRegistry.handleEvent === "function") {
              await nativeToolRegistry.handleEvent(event)
            }
            if (typeof sessionID !== "string" || !backgroundChildren.has(sessionID)) continue
            const status = event.type === "session.execution.succeeded" ? "succeeded"
              : event.type === "session.execution.failed" ? "failed"
                : event.type === "session.execution.interrupted" ? "interrupted"
                  : undefined
            if (status) await handoffBackgroundChild(sessionID, status)
          }
        } catch (error) {
          if (!abortBackgroundHandoffs.signal.aborted) {
            console.error(`[ho-my-rigel] Native V2 background event subscription failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })()
      : undefined
    const registration = await context.tool.transform((editor) => {
      const before = editor.get?.(taskName)
      // Register the skill MCP tool before the delegation tool so a single
      // editor.add capture (used by the runtime tests) still resolves to
      // `rigel_task`. Only expose it once a skill was discovered; a host with
      // no skill MCP server has nothing for it to call.
      if (skillRegistry.skills.length > 0) {
        editor.add(createSkillMcpToolDefinition({
          manager: skillMcpManager,
          getSkills: async () => skillRegistry.skills,
        }))
      }
      editor.add({
        name: taskName,
        options: { codemode: false },
        description: createTaskPresentation(),
        input: taskInput,
        execute: async (input, toolContext) => {
          console.error(`[ho-my-rigel] Native V2 task context: name=${taskName}; setup=${Object.keys(context ?? {}).sort().join(",")}; tool=${Object.keys(toolContext ?? {}).sort().join(",")}`)
          if (isCoordinatorAgent(input.subagent_type)) {
            throw new Error(`Cannot delegate to coordinator agent "${String(input.subagent_type).trim()}" via task. Coordinator agents (prometheus) own the orchestration loop and must not be used as subagent targets - doing so creates duplicate coordinators and conflicting team state. Select a worker agent (e.g., sisyphus-junior via category, hephaestus, oracle) instead.`)
          }
          // In the V2 setup() API, the context itself is the typed service
          // surface. Tool execution receives only turn metadata, not a second
          // API client. Do not assume the V1 `context.client` shape.
          const clients = [context, context.client, toolContext?.client]
          const requestedSkills = Array.isArray(input.load_skills)
            ? input.load_skills.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
            : []
          // Inject the real skill bodies each requested name resolves to.
          // Unknown or disabled names are reported, never silently rewritten
          // into a fake "loaded" notice.
          const prompt = await applyRequestedSkills(input.prompt, requestedSkills, { resolveSkill: resolveSkillForChild })
          if (input.task_id) {
            const resumed = await resumeDelegatedSessionFromClients({
              clients,
              sessionID: input.task_id,
              prompt,
              background: input.run_in_background === true,
            })
            if (resumed.background && toolContext?.sessionID) {
              backgroundChildren.set(resumed.sessionID, { parentSessionID: toolContext.sessionID, agent: resumed.agent })
            }
            return taskResult(resumed)
          }
          const agents = await listCallableAgentsFromClients(clients, location)
          const category = input.category
            ? await resolveCategoryFromClients(clients, location, input.category, { userCategories })
            : undefined
          const agent = category
            ? resolveNamedAgent(agents, "Sisyphus-Junior")
            : resolveNamedAgent(agents, input.subagent_type)
          const delegated = await delegateNamedAgentFromClients({
            clients,
            location,
            agent,
            prompt: category ? categoryTaskPrompt(prompt, category) : prompt,
            background: input.run_in_background === true,
            model: category?.model,
            parentSessionID: toolContext?.sessionID,
            onChildSession: (sessionID, child) => {
              childSessionIDs.add(sessionID)
              if (category) categoryChildSessions.set(sessionID, category.name)
              seedChildFallback(sessionID, child)
            },
          })
          if (delegated.background && toolContext?.sessionID) {
            backgroundChildren.set(delegated.sessionID, { parentSessionID: toolContext.sessionID, agent: delegated.agent })
          }
          return taskResult(delegated)
        },
      })
      if (process.env.RIGEL_NATIVE_ASSERT_TOOL_REGISTRATION === "1") {
        const after = editor.get?.(taskName)
        console.error(`[ho-my-rigel] Native V2 task registration probe: name=${taskName}; editor=${Object.keys(editor ?? {}).sort().join(",")}; before=${Boolean(before)}; after=${Boolean(after)}`)
      }
      // Task 15: register the session, look_at, and (gate-permitting) monitor
      // families through the F2 aggregator. The aggregator reads the manifest's
      // materialized gates via the config adapter, so a disabled family adds no
      // tool name to the editor.
      const families = createNativeToolFamilies({
        clients: [context, context.client],
        location,
        manifest,
        context,
        pluginConfig: context?.config,
      })
      nativeToolRegistry = families.registry
      for (const [name, definition] of Object.entries(families.tools)) {
        editor.add({ name, options: { codemode: false }, ...definition })
      }
    })
    const directoryReadRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.after", async (input) => {
        if (input?.status === "completed") directoryInstructions.recordRead(input)
      })
      : undefined
    const remindersRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.after", async (input) => {
        reminders.after(input)
        applyNativeRecoveryReminder(input)
        rules.after(input)
      })
      : undefined
    const writeGuardRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.before", async (input) => writeGuard.before(input))
      : undefined
    const nonInteractiveRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.before", async (input) => nonInteractiveEnv.before(input))
      : undefined
    // One tool-name permission gate: global `config.tools` gates first, then the
    // per-agent gates collected above, so the last matching gate wins. Deny and
    // ask throw here, before V2 invokes the tool executor.
    const permissionRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.before", async (input) => permissionWiring.before(input))
      : undefined
    const rosterRegistration = await context.session.hook("http.request", createNativeRequestHook({
      // Read on every provider request. This uses exactly the inventory that
      // task() resolves at execution time, not a startup-time copy.
      getDelegationRoster: () => listCallableAgentsFromClients(
        [context, context?.client],
        context.location,
      ),
      categories: buildCategoryRoster(userCategories),
      resolveModel: resolveNativeModel,
      getAgentRequestBody: (agent) => agentRequestBodies.get(String(agent ?? "").toLocaleLowerCase()),
      onAgentTuningApplied: (event) => {
        recordAgentTuning(event)
      },
      ultraworkPrompt,
      defaultUltrawork: manifest.modes?.defaultUltrawork === true,
      getDirectoryInstructions: directoryInstructions.guidance,
      getInitialDirectoryInstructions: ({ agent }) => /\bhephaestus\b/i.test(String(agent ?? ""))
        ? directoryInstructions.rootAgentsGuidance()
        : "",
      // Every child created through this runtime is marked before prompting.
      // The active callable roster is a second guard: a subagent request is
      // never allowed to receive the parent's delegation menu.
      isRootSession: (input, agents) => !childSessionIDs.has(input.sessionID)
        && !agents.some((agent) => agent.name.toLocaleLowerCase() === String(input.agent ?? "").toLocaleLowerCase()),
    }))
    console.error(`[ho-my-rigel] Native OpenCode V2 runtime active: named delegation enabled; registeredAgents=${registeredAgents.join(",")}; agentDomain=${Object.keys(context.agent ?? {}).sort().join(",")}; sessionDomain=${Object.keys(context.session ?? {}).sort().join(",")}`)
    // Conditional native tool families (interactive_bash / task_* / goal_*).
    // Gates come from the materialized manifest; a disabled family is never
    // registered.
    const conditionalTools = await registerConditionalNativeTools({
      context,
      manifest,
      directory: location.directory,
    })
    return async () => {
      abortBackgroundHandoffs.abort()
      directoryInstructions.clearAll()
      reminders.clearAll()
      rules.clearAll()
      writeGuard.clearAll()
      await skillMcpManager.disconnectAll()
      // Stop any live monitor PTY before the plugin tears down, so no watcher
      // process outlives the session.
      if (typeof nativeToolRegistry?.shutdown === "function") {
        try { await nativeToolRegistry.shutdown() } catch (error) {
          console.error(`[ho-my-rigel] Native V2 monitor shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await conditionalTools?.dispose?.()
      await Promise.all([registration?.dispose?.(), directoryReadRegistration?.dispose?.(), remindersRegistration?.dispose?.(), writeGuardRegistration?.dispose?.(), nonInteractiveRegistration?.dispose?.(), permissionRegistration?.dispose?.(), rosterRegistration?.dispose?.(), skillRegistry?.dispose?.(), skillMcpRegistration?.dispose?.(), eventSubscription])
    }
  },
}
