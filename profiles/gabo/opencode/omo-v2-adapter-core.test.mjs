import { describe, expect, test } from "bun:test"
import { createRigelV2Plugin } from "./omo-v2-adapter-core.mjs"

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
  test("registers legacy tools and converts their execution context and result", async () => {
    const runtime = fakeContext()
    const calls = []
    let legacyDisposed = false
    const plugin = createRigelV2Plugin({
      loadLegacyHooks: async () => ({
        tool: {
          rigel_probe: {
            description: "probe",
            args: { value: { _zod: { def: { type: "string" } } } },
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
    expect(runtime.added[0].input).toEqual({ value: { _zod: { def: { type: "string" } } } })
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
    runtime.context.client = {
      agent: {
        list: async (input) => {
          calls.push(input)
          return { data: [{ name: "explore", mode: "subagent" }] }
        },
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

  test("maps the V2 hooks that have a direct legacy equivalent", async () => {
    const runtime = fakeContext()
    const calls = []
    const plugin = createRigelV2Plugin({
      loadLegacyHooks: async () => ({
        tool: {},
        "tool.execute.before": async (input, output) => calls.push(["before", input, output]),
        "tool.execute.after": async (input, output) => calls.push(["after", input, output]),
        "chat.message": async (input, output) => calls.push(["prompt", input, output]),
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
    await runtime.sessionHooks.get("prompt")({ sessionID: "ses_2", messageID: "msg_2", prompt: [{ type: "text", text: "investiga" }] })
    const contextInput = { sessionID: "ses_2", model: "test", system: [{ type: "text", text: "base" }] }
    await runtime.sessionHooks.get("context")(contextInput)
    const compactionInput = { sessionID: "ses_2", result: {} }
    await runtime.sessionHooks.get("compaction")(compactionInput)

    expect(calls).toEqual([
      ["before", { tool: "write", sessionID: "ses_2", callID: "call_2" }, { args: { path: "a" } }],
      ["after", { tool: "write", sessionID: "ses_2", callID: "call_2", args: { path: "a" } }, { title: "Write", output: "done", metadata: { title: "Write" } }],
      ["prompt", { sessionID: "ses_2", messageID: "msg_2" }, { message: [{ type: "text", text: "investiga" }], parts: [{ type: "text", text: "investiga" }] }],
    ])
    expect(contextInput.system).toEqual([{ type: "text", text: "base" }, { type: "text", text: "Rigel system guidance" }])
    expect(compactionInput.result).toEqual({ summary: "Rigel continuity" })
  })
})
