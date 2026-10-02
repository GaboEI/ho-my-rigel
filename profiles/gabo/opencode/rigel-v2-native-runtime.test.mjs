import { expect, test } from "bun:test"
import plugin from "./rigel-v2-native.mjs"

test("native runtime uses the V2 setup context, not context.client", async () => {
  let definition
  const calls = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async ({ location }) => {
        calls.push(["agents", location])
        return { data: [{ id: "explore", name: "Explore", mode: "subagent" }] }
      },
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async (input) => { calls.push(["create", input]); return { data: { id: "ses_native" } } },
      prompt: async (input) => { calls.push(["prompt", input]); return { data: {} } },
    },
    tool: { transform: async (callback) => {
      callback({ add: (value) => { definition = value } })
      return { dispose() {} }
    } },
  }
  const dispose = await plugin.setup(context)
  expect(definition.description).toContain("active V2 agent inventory")
  expect(definition.description).not.toContain("Available named specialists:")
  const result = await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, {})
  expect(result.metadata).toMatchObject({ sessionID: "ses_native", agent: "Explore" })
  expect(calls).toEqual([
    ["agents", { directory: "/native-v2" }],
    ["create", { agent: "explore", location: { directory: "/native-v2" } }],
      ["prompt", { sessionID: "ses_native", text: "<rigel-native-child-task>\nRead only.", resume: true }],
  ])
  await dispose()
})

test("native runtime wakes only the recorded parent when a background child succeeds", async () => {
  let definition
  let yieldEvent
  const prompts = []
  const events = {
    async *[Symbol.asyncIterator]() {
      yield await new Promise((resolve) => { yieldEvent = resolve })
    },
  }
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    event: { subscribe: () => events },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_child" } }),
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "SPECIALIST_EVIDENCE" }] }],
      prompt: async (input) => { prompts.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => { callback({ add: (value) => { definition = value } }); return { dispose() {} } } },
  }
  const dispose = await plugin.setup(context)
  await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })
  yieldEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(prompts).toContainEqual(expect.objectContaining({
    sessionID: "ses_parent",
    resume: true,
    text: expect.stringContaining("<rigel-native-background-result>"),
  }))
  expect(prompts.at(-1).text).toContain("SPECIALIST_EVIDENCE")
  await dispose()
})
