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
  resolveCategoryFromClients,
} from "./rigel-v2-native-categories.mjs"
import fs from "node:fs"
import { createNativeRequestHook } from "./rigel-v2-native-prompt.mjs"
import { createDirectoryInstructionStore } from "./rigel-v2-directory-instructions.mjs"
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
    const registeredAgents = await registerNativeAgents(context.agent, manifest)
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
    const directoryInstructions = createDirectoryInstructionStore({ directory: location.directory })
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
            const sessionID = event?.data?.sessionID
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
            onChildSession: (sessionID) => childSessionIDs.add(sessionID),
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
    const rosterRegistration = await context.session.hook("http.request", createNativeRequestHook({
      // Read on every provider request. This uses exactly the inventory that
      // task() resolves at execution time, not a startup-time copy.
      getDelegationRoster: () => listCallableAgentsFromClients(
        [context, context?.client],
        context.location,
      ),
      categories: availableCategoryNames(),
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
      await Promise.all([registration?.dispose?.(), directoryReadRegistration?.dispose?.(), rosterRegistration?.dispose?.(), eventSubscription])
    }
  },
}
