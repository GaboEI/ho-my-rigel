import {
  delegateNamedAgentFromClients,
  listCallableAgentsFromClients,
  resolveNamedAgent,
  taskResult,
} from "./rigel-v2-native-core.mjs"
import { createNativePromptHook, loadUltraworkDirective } from "./rigel-v2-native-prompt.mjs"
import { categoryTaskPrompt, resolveCategoryFromClients } from "./rigel-v2-native-categories.mjs"

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
    const taskName = process.env.RIGEL_NATIVE_TASK_NAME || "task"
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: taskName,
        description: "Delegate a task to a callable OpenCode V2 subagent or an OmO category.",
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
          })
          return taskResult(delegated)
        },
      })
    })
    const promptRegistration = await context.session.hook("prompt", createNativePromptHook({
      ultraworkDirective: loadUltraworkDirective(),
      // The normal Rigel profile is automatic. The explicit false switch is
      // reserved for isolated delegation QA, where the test must select the
      // native `task` tool without a large orchestration directive competing
      // for the same turn.
      defaultUltrawork: process.env.RIGEL_NATIVE_DEFAULT_ULTRAWORK !== "0",
    }))
    console.error(`[ho-my-rigel] Native OpenCode V2 runtime active: named delegation enabled; agentDomain=${Object.keys(context.agent ?? {}).sort().join(",")}; sessionDomain=${Object.keys(context.session ?? {}).sort().join(",")}`)
    return async () => {
      await Promise.all([registration?.dispose?.(), promptRegistration?.dispose?.()])
    }
  },
}
