import {
  delegateNamedAgentFromClients,
  listCallableAgentsFromClients,
  resolveNamedAgent,
  taskResult,
} from "./rigel-v2-native-core.mjs"
import {
  availableCategoryNames,
  categoryTaskPrompt,
  resolveCategoryFromClients,
} from "./rigel-v2-native-categories.mjs"
import { createNativeRequestHook } from "./rigel-v2-native-prompt.mjs"
import manifest from "./rigel-v2-native-agent-manifest.mjs"
import { registerNativeAgents } from "./rigel-v2-native-agents.mjs"

export function createTaskPresentation() {
  return `Spawn one delegated task through the OpenCode V2 agent runtime.

⚠️ CRITICAL: provide exactly one of category or subagent_type. Omitting both fails; providing both is invalid.

Use subagent_type for a named specialist when its role matches a discrete research, consultation, review, or audit need. Use category for an execution worker with a category-selected model. The main agent chooses the appropriate route based on the active V2 agent inventory; this tool does not impose a routing policy.

For independent work, use run_in_background=true so several lanes can proceed in parallel. Use false only when the result is immediately required before the next action. Prompts must state the child task, scope, constraints, and expected evidence clearly.`
}

// V2 accepts a JSON Schema/Standard Schema/Effect codec. A raw V1 Zod shape
// becomes `unknown` to the model, which silently produces V1 argument names.
const taskInput = {
  type: "object",
  properties: {
    subagent_type: { type: "string", description: "Exact callable agent name; omit when category is supplied." },
    category: { type: "string", description: "OmO category; omit when subagent_type is supplied." },
    description: { type: "string", description: "Short task description." },
    prompt: { type: "string", description: "Full task for the child agent." },
    run_in_background: { type: "boolean", description: "Run independently and return the child session ID." },
  },
  required: ["prompt"],
  additionalProperties: false,
  anyOf: [{ required: ["subagent_type"] }, { required: ["category"] }],
}

export default {
  id: "ho-my-rigel",
  setup: async (context) => {
    const location = context?.location ?? { directory: process.cwd() }
    if (typeof context?.tool?.transform !== "function") {
      throw new Error("OpenCode V2 tool.transform is unavailable")
    }
    const registeredAgents = await registerNativeAgents(context.agent, manifest)
    // V2 owns `task` after plugin transforms complete, so registering that
    // name here creates an editor entry the model never receives. A distinct
    // name is required for a real, callable Rigel delegation surface.
    const taskName = process.env.RIGEL_NATIVE_TASK_NAME || "rigel_task"
    const childSessionIDs = new Set()
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
            prompt: category ? categoryTaskPrompt(input.prompt, category) : input.prompt,
            background: input.run_in_background !== false,
            model: category?.model,
            onChildSession: (sessionID) => childSessionIDs.add(sessionID),
          })
          return taskResult(delegated)
        },
      })
      if (process.env.RIGEL_NATIVE_ASSERT_TOOL_REGISTRATION === "1") {
        const after = editor.get?.(taskName)
        console.error(`[ho-my-rigel] Native V2 task registration probe: name=${taskName}; editor=${Object.keys(editor ?? {}).sort().join(",")}; before=${Boolean(before)}; after=${Boolean(after)}`)
      }
    })
    const rosterRegistration = await context.session.hook("http.request", createNativeRequestHook({
      // Read on every provider request. This uses exactly the inventory that
      // task() resolves at execution time, not a startup-time copy.
      getDelegationRoster: () => listCallableAgentsFromClients(
        [context, context?.client],
        context.location,
      ),
      categories: availableCategoryNames(),
      // Every child created through this runtime is marked before prompting.
      // The active callable roster is a second guard: a subagent request is
      // never allowed to receive the parent's delegation menu.
      isRootSession: (input, agents) => !childSessionIDs.has(input.sessionID)
        && !agents.some((agent) => agent.name.toLocaleLowerCase() === String(input.agent ?? "").toLocaleLowerCase()),
    }))
    console.error(`[ho-my-rigel] Native OpenCode V2 runtime active: named delegation enabled; registeredAgents=${registeredAgents.join(",")}; agentDomain=${Object.keys(context.agent ?? {}).sort().join(",")}; sessionDomain=${Object.keys(context.session ?? {}).sort().join(",")}`)
    return async () => {
      await Promise.all([registration?.dispose?.(), rosterRegistration?.dispose?.()])
    }
  },
}
