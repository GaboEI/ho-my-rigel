import { expect, test } from "bun:test"
import { createNativeToolFamilies } from "./rigel-v2-native-tools.mjs"

// A minimal V2 setup context: the session domain for session_* and look_at, and
// the pty/storage domains for monitor. The aggregator only reads these at
// construction; the tools resolve them lazily at execute.
function fakeContext() {
  return {
    session: {
      list: async () => ({ data: [] }),
      get: async () => ({ data: undefined }),
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
      wait: async () => {},
      context: async () => ({ data: [] }),
    },
    pty: { create: async () => ({ data: { id: "pty_1" } }), remove: async () => {}, snapshot: async () => ({ data: { text: "" } }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => [] },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  }
}

function familiesFor(manifest) {
  return createNativeToolFamilies({
    clients: [fakeContext()],
    location: { directory: "/work" },
    manifest,
    context: fakeContext(),
    pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } },
  })
}

test("the aggregator always registers the session and look_at families", () => {
  const { tools } = familiesFor({})
  for (const name of ["session_list", "session_read", "session_search", "session_info", "look_at"]) {
    expect(tools[name]).toBeDefined()
  }
})

test("the monitor family is absent when the monitor gate is off", () => {
  const { tools, registry } = familiesFor({ metadata: { global: { gates: { monitor: false } } } })
  for (const name of ["monitor_start", "monitor_stop", "monitor_list", "monitor_output"]) {
    expect(tools[name]).toBeUndefined()
  }
  expect(registry).toBeUndefined()
})

test("the monitor family is registered when the monitor gate is on", () => {
  const { tools, registry } = familiesFor({ metadata: { global: { gates: { monitor: true } } } })
  for (const name of ["monitor_start", "monitor_stop", "monitor_list", "monitor_output"]) {
    expect(tools[name]).toBeDefined()
  }
  expect(registry).toBeDefined()
})

test("every registered tool exposes a description, input schema, and execute", () => {
  const { tools } = familiesFor({ metadata: { global: { gates: { monitor: true } } } })
  for (const [name, definition] of Object.entries(tools)) {
    expect(typeof definition.description, name).toBe("string")
    expect(definition.input?.type, name).toBe("object")
    expect(typeof definition.execute, name).toBe("function")
  }
})
