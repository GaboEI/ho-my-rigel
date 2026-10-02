import { describe, expect, test } from "bun:test"
import {
  delegateNamedAgent,
  completedChildText,
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
        { id: "explore", name: "Explore", mode: "subagent" },
        { name: "oracle", mode: "subagent" },
        { name: "forja", mode: "subagent", hidden: true },
      ] } } },
    }
    const location = { directory: "/isolated/project" }
    const agents = await listCallableAgents(client, location)
    expect(calls).toEqual([{ location }])
    expect(agents.map((agent) => agent.name)).toEqual(["Explore", "oracle"])
    expect(resolveNamedAgent(agents, "explore")).toMatchObject({ id: "explore", name: "Explore" })
    expect(resolveNamedAgent(agents, "oracle")).toMatchObject({ name: "oracle", mode: "subagent" })
    expect(resolveNamedAgent([{ name: "Explore", mode: "subagent" }], "explore")).toMatchObject({ name: "Explore" })
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

  test("creates a parent-linked foreground child and returns its final text through V2 sessions", async () => {
    const calls = []
    const client = {
      session: {
        create: async (input) => { calls.push(["create", input]); return { data: { id: "ses_child" } } },
        prompt: async (input) => { calls.push(["prompt", input]); return { data: {} } },
        wait: async (input) => { calls.push(["wait", input]) },
        context: async (input) => { calls.push(["context", input]); return { data: [{ type: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "SPECIALIST_EVIDENCE" }] }] } },
      },
    }
    const delegated = await delegateNamedAgent({
      client,
      location: { directory: "/isolated/project" },
      agent: { id: "explore", name: "Explore", mode: "subagent" },
      prompt: "List root files only.",
      parentSessionID: "ses_parent",
    })
    expect(delegated).toEqual({ sessionID: "ses_child", agent: "Explore", background: false, result: "SPECIALIST_EVIDENCE" })
    expect(calls).toEqual([
      ["create", { agent: "explore", location: { directory: "/isolated/project" }, parentID: "ses_parent" }],
      ["prompt", { sessionID: "ses_child", text: "<rigel-native-child-task>\nList root files only.", resume: true }],
      ["wait", { sessionID: "ses_child" }],
      ["context", { sessionID: "ses_child" }],
    ])
    expect(taskResult(delegated)).toMatchObject({ content: expect.stringContaining("SPECIALIST_EVIDENCE"), metadata: { sessionID: "ses_child", agent: "Explore", background: false } })
  })

  test("extracts only the completed child's visible text", () => {
    expect(completedChildText({ data: [
      { type: "assistant", content: [{ type: "text", text: "old" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "do not expose" }, { type: "text", text: "final evidence" }] },
    ] })).toBe("final evidence")
  })
})
