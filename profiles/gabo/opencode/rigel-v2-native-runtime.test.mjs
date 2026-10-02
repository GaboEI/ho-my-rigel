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
