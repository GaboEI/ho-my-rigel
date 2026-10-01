import {
  delegateNamedAgent,
  listCallableAgents,
  resolveNamedAgent,
  taskResult,
} from "./rigel-v2-native-core.mjs"
import { createNativePromptHook, loadUltraworkDirective } from "./rigel-v2-native-prompt.mjs"

const taskInput = {
  subagent_type: { _zod: { def: { type: "string" } } },
  description: { _zod: { def: { type: "string" } } },
  prompt: { _zod: { def: { type: "string" } } },
  run_in_background: { _zod: { def: { type: "boolean" } } },
}

export default {
  id: "ho-my-rigel",
  setup: async (context) => {
    const location = context?.location ?? { directory: process.cwd() }
    if (typeof context?.tool?.transform !== "function") {
      throw new Error("OpenCode V2 tool.transform is unavailable")
    }
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: "task",
        description: "Delegate a task to a callable OpenCode V2 subagent.",
        input: taskInput,
        execute: async (input, toolContext) => {
          const client = toolContext?.client ?? context.client
          const agents = await listCallableAgents(client, location)
          const agent = resolveNamedAgent(agents, input.subagent_type)
          const delegated = await delegateNamedAgent({
            client,
            location,
            agent,
            prompt: input.prompt,
            background: input.run_in_background !== false,
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
    console.error("[ho-my-rigel] Native OpenCode V2 runtime active: named delegation enabled; inventory resolves at invocation time")
    return async () => {
      await Promise.all([registration?.dispose?.(), promptRegistration?.dispose?.()])
    }
  },
}
