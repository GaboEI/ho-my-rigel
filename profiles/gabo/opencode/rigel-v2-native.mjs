import {
  delegateNamedAgentFromClients,
  listCallableAgentsFromClients,
  resolveNamedAgent,
  taskResult,
  resumeDelegatedSessionFromClients,
  completedChildText,
  backgroundHandoffPrompt,
} from "./rigel-v2-native-core.mjs"
import {
  availableCategoryNames,
  categoryTaskPrompt,
  listV2ModelsFromClients,
  resolveCategoryFromClients,
} from "./rigel-v2-native-categories.mjs"
import fs from "node:fs"
import { createNativeRequestHook } from "./rigel-v2-native-prompt.mjs"
import { agentChain, categoryChain, resolveFallbackModel } from "./rigel-v2-native-model-chains.mjs"
import { createDirectoryInstructionStore } from "./rigel-v2-directory-instructions.mjs"
import { createNativeToolResultReminders } from "./rigel-v2-native-reminders.mjs"
import { applyNativeRecoveryReminder } from "./rigel-v2-native-recovery.mjs"
import { createNativeRulesInjector } from "./rigel-v2-native-rules.mjs"
import { createNativeWriteExistingFileGuard } from "./rigel-v2-native-write-guard.mjs"
import { createNativeNonInteractiveEnvGuard } from "./rigel-v2-native-noninteractive.mjs"
import manifest from "./rigel-v2-native-agent-manifest.mjs"
import { registerNativeAgents } from "./rigel-v2-native-agents.mjs"

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

export default {
  id: "ho-my-rigel",
  setup: async (context) => {
    const location = context?.location ?? { directory: process.cwd() }
    if (typeof context?.tool?.transform !== "function") {
      throw new Error("OpenCode V2 tool.transform is unavailable")
    }
    const registeredAgents = await registerNativeAgents(context.agent, manifest, {
      // Proactive fallback runs at this pre-selection boundary: the live
      // inventory decides each agent's starting model before `agent.reload`,
      // so an agent whose primary is absent starts on the next chain rung
      // instead of being rejected by V2 before any request hook can run.
      listModels: () => listV2ModelsFromClients([context, context?.client], location),
    })
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
            }
            // Reactive fallback: a failed execution marks the last-sent model
            // failed for that session, so the next request resolves the next
            // reachable rung. Independent of the background-handoff wake.
            if (typeof sessionID === "string" && (event.type === "session.execution.failed" || event.type === "session.error")) {
              await applyReactiveFallback(sessionID)
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
      editor.add({
        name: taskName,
        options: { codemode: false },
        description: createTaskPresentation(),
        input: taskInput,
        execute: async (input, toolContext) => {
          console.error(`[ho-my-rigel] Native V2 task context: name=${taskName}; setup=${Object.keys(context ?? {}).sort().join(",")}; tool=${Object.keys(toolContext ?? {}).sort().join(",")}`)
          // In the V2 setup() API, the context itself is the typed service
          // surface. Tool execution receives only turn metadata, not a second
          // API client. Do not assume the V1 `context.client` shape.
          const clients = [context, context.client, toolContext?.client]
          const requestedSkills = Array.isArray(input.load_skills)
            ? input.load_skills.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
            : []
          const prompt = requestedSkills.length > 0
            ? `${input.prompt}\n\n<rigel-requested-skills>Before working, load these native skills if available: ${requestedSkills.join(", ")}</rigel-requested-skills>`
            : input.prompt
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
            ? await resolveCategoryFromClients(clients, location, input.category)
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
    const rosterRegistration = await context.session.hook("http.request", createNativeRequestHook({
      // Read on every provider request. This uses exactly the inventory that
      // task() resolves at execution time, not a startup-time copy.
      getDelegationRoster: () => listCallableAgentsFromClients(
        [context, context?.client],
        context.location,
      ),
      categories: availableCategoryNames(),
      resolveModel: resolveNativeModel,
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
    return async () => {
      abortBackgroundHandoffs.abort()
      directoryInstructions.clearAll()
      reminders.clearAll()
      rules.clearAll()
      writeGuard.clearAll()
      await Promise.all([registration?.dispose?.(), directoryReadRegistration?.dispose?.(), remindersRegistration?.dispose?.(), writeGuardRegistration?.dispose?.(), nonInteractiveRegistration?.dispose?.(), rosterRegistration?.dispose?.(), eventSubscription])
    }
  },
}
