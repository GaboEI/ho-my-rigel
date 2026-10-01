import { describe, expect, test } from "bun:test"
import {
  delegateNamedAgent,
  listCallableAgents,
  resolveNamedAgent,
  taskResult,
} from "./rigel-v2-native-core.mjs"

describe("Rigel native OpenCode V2 delegation", () => {
  test("uses V2 location-scoped discovery and resolves a callable named agent", async () => {
    const calls = []
    const client = {
      agent: { list: async (input) => { calls.push(input); return { data: [
        { name: "Sisyphus - ultraworker", mode: "primary" },
        { name: "explore", mode: "subagent" },
        { name: "oracle", mode: "subagent" },
        { name: "forja", mode: "subagent", hidden: true },
      ] } } },
    }
    const location = { directory: "/isolated/project" }
    const agents = await listCallableAgents(client, location)
    expect(calls).toEqual([{ location }])
    expect(agents.map((agent) => agent.name)).toEqual(["explore", "oracle"])
    expect(resolveNamedAgent(agents, "oracle")).toMatchObject({ name: "oracle", mode: "subagent" })
  })

  test("uses V2's scoped app.agents surface when that is the plugin-host client", async () => {
    const calls = []
    const client = { app: { agents: async (input) => { calls.push(input); return { data: [{ name: "explore", mode: "subagent" }] } } } }
    const location = { directory: "/isolated/project" }
    expect(await listCallableAgents(client, location)).toMatchObject([{ name: "explore" }])
    expect(calls).toEqual([{ directory: "/isolated/project" }])
  })

  test("rejects hidden, primary, and unknown names with a usable inventory", async () => {
    const agents = [{ name: "explore", mode: "subagent", hidden: false }]
    expect(() => resolveNamedAgent(agents, "oracle")).toThrow('Unknown agent: "oracle". Available agents: explore')
  })

  test("creates and schedules a child exclusively through V2 sessions", async () => {
    const calls = []
    const client = {
      session: {
        create: async (input) => { calls.push(["create", input]); return { data: { id: "ses_child" } } },
        prompt: async (input) => { calls.push(["prompt", input]); return { data: {} } },
      },
    }
    const delegated = await delegateNamedAgent({
      client,
      location: { directory: "/isolated/project" },
      agent: { name: "explore", mode: "subagent" },
      prompt: "List root files only.",
    })
    expect(delegated).toEqual({ sessionID: "ses_child", agent: "explore", background: true })
    expect(calls).toEqual([
      ["create", { agent: "explore", location: { directory: "/isolated/project" } }],
      ["prompt", { sessionID: "ses_child", prompt: { text: "<rigel-native-child-task>\nList root files only." }, resume: true }],
    ])
    expect(taskResult(delegated)).toMatchObject({ metadata: { sessionID: "ses_child", agent: "explore", background: true } })
  })
})
