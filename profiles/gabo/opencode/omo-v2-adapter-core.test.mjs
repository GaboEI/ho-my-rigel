import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { createRigelV2Plugin, legacyArgsToJsonSchema } from "./omo-v2-adapter-core.mjs"

function fakeContext() {
  const added = []
  const toolHooks = new Map()
  const sessionHooks = new Map()
  const disposed = []
  const registration = (name) => ({ dispose: async () => { disposed.push(name) } })
  return {
    added,
    toolHooks,
    sessionHooks,
    disposed,
    context: {
      location: { directory: "/isolated/project" },
      tool: {
        transform: async (callback) => {
          callback({ add: (definition) => added.push(definition) })
          return registration("tool.transform")
        },
        hook: async (name, callback) => {
          toolHooks.set(name, callback)
          return registration(`tool.${name}`)
        },
      },
      session: {
        hook: async (name, callback) => {
          sessionHooks.set(name, callback)
          return registration(`session.${name}`)
        },
      },
    },
  }
}

describe("Ho My Rigel OpenCode V2 bridge", () => {
  test("converts the V1 Zod field shape into the one JSON Schema V2 accepts", () => {
    expect(legacyArgsToJsonSchema("search", {
      query: z.string().describe("Query to search"),
      limit: z.number().int().optional(),
    })).toMatchObject({
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Query to search" },
        limit: { type: "integer" },
      },
    })
  })

  test("registers legacy tools and converts their execution context and result", async () => {
    const runtime = fakeContext()
    const calls = []
    let legacyDisposed = false
    const plugin = createRigelV2Plugin({
      loadLegacyHooks: async () => ({
        tool: {
          rigel_probe: {
            description: "probe",
            args: { value: z.string() },
            execute: async (input, context) => {
              calls.push({ input, context })
              return { title: "Probe", output: "ok", metadata: { source: "test" } }
            },
          },
        },
        dispose: async () => { legacyDisposed = true },
      }),
    })

    const dispose = await plugin.setup(runtime.context)
    expect(runtime.added).toHaveLength(1)
    expect(runtime.added[0].options).toEqual({ codemode: false })
    expect(runtime.added[0].input).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    })
    const result = await runtime.added[0].execute({ value: "hello" }, {
      sessionID: "ses_1", messageID: "msg_1", agent: "Sisyphus - ultraworker", signal: "abort", progress: () => undefined,
    })
    expect(result).toEqual({ content: "ok", metadata: { source: "test", title: "Probe" } })
    expect(calls[0].context).toMatchObject({ sessionID: "ses_1", messageID: "msg_1", directory: "/isolated/project", abort: "abort" })
    await dispose()
    expect(legacyDisposed).toBe(true)
    expect(runtime.disposed).toEqual(["tool.transform"])
  })

  test("adapts V2 agent.list to the legacy app.agents contract used by task", async () => {
    const runtime = fakeContext()
    const calls = []
    runtime.context.agent = {
      list: async (input) => {
        calls.push(input)
        return { data: [{ id: "explore", name: "explore", mode: "subagent" }] }
      },
    }
    const plugin = createRigelV2Plugin({
      loadLegacyHooks: async () => ({
        tool: {
          delegate_probe: {
            description: "delegation client probe",
            args: {},
            execute: async (_input, context) => JSON.stringify(await context.client.app.agents()),
          },
        },
      }),
    })
    await plugin.setup(runtime.context)
    const result = await runtime.added[0].execute({}, {
      sessionID: "ses_3", messageID: "msg_3", agent: "Sisyphus - ultraworker", signal: "abort", progress: () => undefined,
    })
    expect(JSON.parse(result.content)).toEqual({ data: [{ name: "explore", mode: "subagent" }] })
    expect(calls).toEqual([{ location: { directory: "/isolated/project" } }])
  })

  test("uses context.session for the legacy child-session operations", async () => {
    const runtime = fakeContext()
    const calls = []
    runtime.context.session = {
      ...runtime.context.session,
      get: async (input) => { calls.push(["get", input]); return { id: input.sessionID, directory: "/isolated/project" } },
      create: async (input) => { calls.push(["create", input]); return { id: "ses_child" } },
      prompt: async (input) => { calls.push(["prompt", input]); return {} },
    }
    const plugin = createRigelV2Plugin({
      loadLegacyHooks: async ({ client }) => ({
        tool: {
          session_probe: {
            description: "native V2 session facade probe",
            args: {},
            execute: async () => {
              await client.session.get({ path: { id: "ses_parent" } })
              const created = await client.session.create({ body: { parentID: "ses_parent", title: "child" }, query: { directory: "/isolated/project" } })
              await client.session.prompt({ path: { id: created.data.id }, body: { parts: [{ type: "text", text: "do work" }] } })
              return "ok"
            },
          },
        },
      }),
    })
    await plugin.setup(runtime.context)
    const result = await runtime.added[0].execute({}, {
      sessionID: "ses_6", messageID: "msg_6", agent: "Sisyphus - ultraworker", signal: "abort", progress: () => undefined,
    })
    expect(result.content).toBe("ok")
    expect(calls).toEqual([
      ["get", { sessionID: "ses_parent" }],
      ["create", { parentID: "ses_parent", title: "child", location: { directory: "/isolated/project" } }],
      ["prompt", { parts: [{ type: "text", text: "do work" }], sessionID: "ses_child", text: "do work", resume: true }],
    ])
  })

  test("maps the V2 hooks that have a direct legacy equivalent", async () => {
    const runtime = fakeContext()
    const calls = []
    const plugin = createRigelV2Plugin({
      loadLegacyHooks: async () => ({
        tool: {},
        "tool.execute.before": async (input, output) => calls.push(["before", input, output]),
        "tool.execute.after": async (input, output) => calls.push(["after", input, output]),
        "chat.message": async (input, output) => {
          output.parts = [{ type: "text", text: "transformado" }]
          output.message.model = { providerID: "test", modelID: "replacement-model" }
          calls.push(["chat", input, output])
        },
        "experimental.chat.system.transform": async (_input, output) => { output.system.push("Rigel system guidance") },
        "experimental.session.compacting": async (_input, output) => { output.context.push("Rigel continuity") },
      }),
    })

    await plugin.setup(runtime.context)
    await runtime.toolHooks.get("execute.before")({ tool: "write", sessionID: "ses_2", id: "call_2", input: { path: "a" } })
    await runtime.toolHooks.get("execute.after")({
      tool: "write", sessionID: "ses_2", id: "call_2", input: { path: "a" }, status: "completed",
      result: { content: [{ type: "text", text: "done" }], metadata: { title: "Write" } },
    })
    const requestInput = {
      kind: "primary",
      sessionID: "ses_2",
      agent: "Sisyphus - ultraworker",
      model: { providerID: "test", id: "model" },
      request: new Request("https://example.invalid/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "initial-model", messages: [
          { role: "system", content: "base" },
          { role: "user", content: "investiga" },
        ] }),
      }),
    }
    await runtime.sessionHooks.get("http.request")(requestInput)

    expect(runtime.sessionHooks.size).toBe(1)
    expect(calls).toEqual([
      ["before", { tool: "write", sessionID: "ses_2", callID: "call_2" }, { args: { path: "a" } }],
      ["after", { tool: "write", sessionID: "ses_2", callID: "call_2", args: { path: "a" } }, { title: "Write", output: "done", metadata: { title: "Write" } }],
      ["chat", { sessionID: "ses_2", agent: "Sisyphus - ultraworker", model: { providerID: "test", modelID: "model" } }, { message: { model: { providerID: "test", modelID: "replacement-model" } }, parts: [{ type: "text", text: "transformado" }] }],
    ])
    const rewritten = await requestInput.request.json()
    expect(rewritten.model).toBe("replacement-model")
    expect(rewritten.messages).toEqual([
      { role: "system", content: "base" },
      { role: "system", content: "Rigel system guidance" },
      { role: "user", content: "transformado" },
    ])
  })
})
