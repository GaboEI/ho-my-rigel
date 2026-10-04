import { expect, test } from "bun:test"
import { createNativeToolFamilies } from "./rigel-v2-native-tools.mjs"

// A minimal V2 setup context: the session domain for session_* and look_at, and
// the storage/event/session domains the monitor registry reads. The aggregator
// only reads these at construction; the tools resolve them lazily at execute.
// There is deliberately no pty domain: monitors run on the HTTP persistent
// terminal served by `serverApi`.
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
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => [] },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  }
}

// A fake injected HTTP server API with the terminal methods the persistent
// terminal port calls. `available` mirrors createServerApi's capability flag.
function fakeServerApi() {
  return {
    available: true,
    origin: "http://127.0.0.1:4321",
    createTerminal: async () => ({ ok: true, data: { id: "pty_1" } }),
    listTerminals: async () => ({ ok: true, data: [] }),
    snapshotTerminal: async () => ({ ok: true, data: { text: "", info: undefined } }),
    removeTerminal: async () => ({ ok: true }),
  }
}

function familiesFor(manifest, { serverApi = fakeServerApi() } = {}) {
  return createNativeToolFamilies({
    clients: [fakeContext()],
    location: { directory: "/work" },
    manifest,
    context: fakeContext(),
    pluginConfig: { monitor: { enabled: true, allowed_commands: ["tail"] } },
    serverApi,
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

test("the monitor family is registered from the server API when the monitor gate is on", () => {
  const { tools, registry, unavailable } = familiesFor({ metadata: { global: { gates: { monitor: true } } } })
  for (const name of ["monitor_start", "monitor_stop", "monitor_list", "monitor_output"]) {
    expect(tools[name]).toBeDefined()
  }
  expect(registry).toBeDefined()
  expect(unavailable.some((entry) => entry.family === "monitor")).toBe(false)
})

test("the monitor family reports a typed unavailable entry when the server API is absent", () => {
  const { tools, registry, unavailable } = familiesFor({ metadata: { global: { gates: { monitor: true } } } }, { serverApi: null })
  for (const name of ["monitor_start", "monitor_stop", "monitor_list", "monitor_output"]) {
    expect(tools[name]).toBeUndefined()
  }
  expect(registry).toBeUndefined()
  const entry = unavailable.find((candidate) => candidate.family === "monitor")
  expect(entry).toBeDefined()
  expect(typeof entry.reason).toBe("string")
})

test("the monitor family stays unavailable when the origin resolves but the credential does not", () => {
  const { tools, registry, unavailable } = familiesFor(
    { metadata: { global: { gates: { monitor: true } } } },
    { serverApi: { available: false, origin: "http://127.0.0.1:4321" } },
  )
  for (const name of ["monitor_start", "monitor_stop", "monitor_list", "monitor_output"]) {
    expect(tools[name]).toBeUndefined()
  }
  expect(registry).toBeUndefined()
  expect(unavailable.some((entry) => entry.family === "monitor")).toBe(true)
})

test("every registered tool exposes a description, input schema, and execute", () => {
  const { tools } = familiesFor({ metadata: { global: { gates: { monitor: true } } } })
  for (const [name, definition] of Object.entries(tools)) {
    expect(typeof definition.description, name).toBe("string")
    expect(definition.input?.type, name).toBe("object")
    expect(typeof definition.execute, name).toBe("function")
  }
})
