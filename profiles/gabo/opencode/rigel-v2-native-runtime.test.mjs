import { expect, test } from "bun:test"
import plugin from "./rigel-v2-native.mjs"
import * as nativeRuntime from "./rigel-v2-native.mjs"
import { registerNativeAgents } from "./rigel-v2-native-agents.mjs"

// Deterministic event feed for the reactive-fallback tests. The generator
// blocks until an event is pushed, and signals consumption only AFTER the
// runtime finished processing it, so tests synchronize on the loop advancing
// instead of guessing with a sleep. The abort signal ends the generator so
// `dispose()` never hangs.
function createEventFeed() {
  const queue = []
  let notify
  let onConsumed
  let abortSignal
  const events = {
    async *[Symbol.asyncIterator]() {
      while (!abortSignal?.aborted) {
        while (queue.length === 0) {
          if (abortSignal?.aborted) return
          await new Promise((resolve) => {
            notify = resolve
            abortSignal?.addEventListener("abort", resolve, { once: true })
          })
        }
        if (abortSignal?.aborted) return
        yield queue.shift()
        const consumed = onConsumed
        onConsumed = undefined
        consumed?.()
      }
    },
  }
  return {
    events,
    requestHook: undefined,
    subscribe: ({ signal } = {}) => { abortSignal = signal; return events },
    push(event) {
      queue.push(event)
      const resolve = notify
      notify = undefined
      resolve?.()
    },
    consumed() {
      return new Promise((resolve) => { onConsumed = resolve })
    },
  }
}

function reactiveFallbackContext(feed, { switchModel, models } = {}) {
  return {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: models ?? [
      { providerID: "opencode-go", id: "qwen3.7-plus", enabled: true },
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
    ] }) },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "http.request") { feed.requestHook = handler } return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
      ...(switchModel ? { switchModel } : {}),
    },
    tool: { transform: async (callback) => { callback({ add() {} }); return { dispose() {} } } },
  }
}

function childRequest() {
  return {
    sessionID: "ses_child",
    agent: "explore",
    model: { providerID: "opencode-go", modelID: "grok-4.7" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.7", messages: [{ role: "user", content: "work" }] }),
    }),
  }
}

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

test("native runtime rejects coordinator delegation before any agent or session work", async () => {
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
  await expect(definition.execute({ subagent_type: "Prometheus - Plan Builder", prompt: "Plan this.", run_in_background: true }, {})).rejects.toThrow("Cannot delegate to coordinator agent")
  expect(calls).toEqual([])
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

test("native runtime resolves the next chain rung when the primary model is unavailable", async () => {
  let requestHook
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: [{ providerID: "opencode-go", id: "kimi-k3", enabled: true }] }) },
    session: {
      hook: async (name, handler) => { if (name === "http.request") requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: { transform: async (callback) => { callback({ add() {} }); return { dispose() {} } } },
  }
  const dispose = await plugin.setup(context)
  const input = {
    sessionID: "ses_root",
    agent: "Sisyphus - ultraworker",
    model: { providerID: "opencode-go", modelID: "kimi-k3" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "missing-primary", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await requestHook(input)
  expect((await input.request.clone().json()).model).toBe("kimi-k3")
  await dispose()
})

test("native runtime keeps reactive fallback inside the provider V2 already selected", async () => {
  let requestHook
  let definition
  let yieldEvent
  const prompts = []
  const handoff = (() => {
    let resolve
    const promise = new Promise((settle) => { resolve = settle })
    return { promise, resolve }
  })()
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
    model: { list: async () => ({ data: [
      { providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", enabled: true },
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
    ] }) },
    event: { subscribe: () => events },
    session: {
      hook: async (name, handler) => { if (name === "http.request") requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async (input) => {
        prompts.push(input)
        if (typeof input.text === "string" && input.text.includes("<rigel-native-background-result>")) handoff.resolve(input)
        return { data: {} }
      },
    },
    tool: { transform: async (callback) => { callback({ add: (value) => { definition = value } }); return { dispose() {} } } },
  }
  const dispose = await plugin.setup(context)
  await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })

  // V2 already selected openai. The explore chain's first rung is kimi, so a
  // cross-provider fallback would hand kimi to the openai route.
  const request = () => ({
    sessionID: "ses_child",
    agent: "explore",
    model: { providerID: "openai", modelID: "gpt-6-luna-fast" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-for-coding-highspeed", messages: [{ role: "user", content: "work" }] }),
    }),
  })

  const first = request()
  await requestHook(first)
  expect((await first.request.clone().json()).model).toBe("gpt-6-luna-fast")

  yieldEvent({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  const signal = await Promise.race([
    handoff.promise.then(() => "handoff"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
  ])
  expect(signal).toBe("handoff")

  const second = request()
  await requestHook(second)
  const secondModel = (await second.request.clone().json()).model
  expect(secondModel).not.toBe("kimi-for-coding-highspeed")
  expect(secondModel).toBe("gpt-6-luna-fast")
  await dispose()
})

test("native runtime applies a reactive fallback rung through session.switchModel", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed, {
    switchModel: async (input) => { switched.push(input); return { data: {} } },
  })
  const dispose = await plugin.setup(context)
  expect(typeof feed.requestHook).toBe("function")

  const first = childRequest()
  await feed.requestHook(first)
  expect((await first.request.clone().json()).model).toBe("qwen3.7-plus")

  const consumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
  // The reactive walk is cross-provider: the first reachable rung of the
  // explore chain after grok-4.7 is gpt-6-luna-fast on openai, so switchModel
  // must carry that providerID.
  expect(switched).toEqual([
    { sessionID: "ses_child", model: { providerID: "openai", id: "gpt-6-luna-fast" } },
  ])
  await dispose()
})

test("native runtime reactive fallback changes provider when the next chain rung requires it", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed, {
    // Only the openai rung is available; kimi (rung 1) and opencode-go rungs
    // are absent, so the reactive step must cross from opencode-go to openai.
    switchModel: async (input) => { switched.push(input); return { data: {} } },
    models: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }],
  })
  const dispose = await plugin.setup(context)

  const first = childRequest()
  await feed.requestHook(first)
  // Same-provider guard at http.request: no opencode-go rung is available, so
  // the late body rewrite leaves the payload alone.
  expect((await first.request.clone().json()).model).toBe("grok-4.7")

  const consumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
  expect(switched).toEqual([
    { sessionID: "ses_child", model: { providerID: "openai", id: "gpt-6-luna-fast" } },
  ])
  await dispose()
})

test("native runtime does not switch the model when no chain rung resolves", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed, {
    switchModel: async (input) => { switched.push(input); return { data: {} } },
    // Empty inventory: no rung of the explore chain is reachable.
    models: [],
  })
  const dispose = await plugin.setup(context)

  const first = childRequest()
  await feed.requestHook(first)
  expect((await first.request.clone().json()).model).toBe("grok-4.7")

  const consumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
  expect(switched).toEqual([])
  await dispose()
})

test("native runtime seeds a category child so a pre-request failure still falls back", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "Sisyphus-Junior", name: "Sisyphus-Junior", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    // The category chain's first reachable rung is opencode-go/mimo-v2.6-pro;
    // the next reachable rung is openai/gpt-5.6-terra (cross-provider).
    model: { list: async () => ({ data: [
      { providerID: "opencode-go", id: "mimo-v2.6-pro", enabled: true },
      { providerID: "openai", id: "gpt-5.6-terra", enabled: true },
    ] }) },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "http.request") feed.requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_category_child" } }),
      prompt: async () => ({ data: {} }),
      wait: async () => {},
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
      switchModel: async (input) => { switched.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => {
      let definition
      callback({ add: (value) => { definition = value }, get: () => definition })
      feed.definition = definition
      return { dispose() {} }
    } },
  }
  const dispose = await plugin.setup(context)
  await feed.definition.execute({ category: "unspecified-low", prompt: "Work." }, { sessionID: "ses_parent" })

  // The child never reached http.request; the failure arrives directly.
  const consumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_category_child" } })
  await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
  expect(switched).toEqual([
    { sessionID: "ses_category_child", model: { providerID: "openai", id: "gpt-5.6-terra" } },
  ])
  await dispose()
})

test("native runtime advances the tracked model across consecutive failures", async () => {
  const switched = []
  const feed = createEventFeed()
  // explore chain reachable rungs: opencode-go qwen3.7-plus, then opencode-go
  // minimax-m2.7. Two failures must switch qwen then minimax; a stalled walk
  // would switch qwen twice.
  const context = reactiveFallbackContext(feed, {
    switchModel: async (input) => { switched.push(input); return { data: {} } },
    models: [
      { providerID: "opencode-go", id: "qwen3.7-plus", enabled: true },
      { providerID: "opencode-go", id: "minimax-m2.7", enabled: true },
    ],
  })
  const dispose = await plugin.setup(context)

  const first = childRequest()
  await feed.requestHook(first)
  expect((await first.request.clone().json()).model).toBe("qwen3.7-plus")

  const firstConsumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  await Promise.race([firstConsumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])

  const secondConsumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  await Promise.race([secondConsumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])

  expect(switched).toEqual([
    { sessionID: "ses_child", model: { providerID: "opencode-go", id: "qwen3.7-plus" } },
    { sessionID: "ses_child", model: { providerID: "opencode-go", id: "minimax-m2.7" } },
  ])
  await dispose()
})

test("native runtime survives a reactive failure when session.switchModel is absent", async () => {
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed)
  const dispose = await plugin.setup(context)

  const first = childRequest()
  await feed.requestHook(first)

  const firstConsumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  await Promise.race([firstConsumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])

  const secondConsumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  const second = await Promise.race([
    secondConsumed.then(() => "second"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
  ])
  expect(second).toBe("second")
  await dispose()
})

// Task 10: the runtime collects every agent's tool gates through
// `registerNativeAgents.onAgentPermissions`, merges the global gates first so
// an agent-specific gate wins, indexes each agent by manifest id and display
// name, and blocks a denied call in `execute.before` before the executor runs.
function permissionManifest() {
  return {
    agents: {
      sisyphus: { name: "Sisyphus - ultraworker", mode: "primary", permission: { teammate: "allow", task: "allow", call_omo_agent: "allow" } },
      "multimodal-looker": { name: "Multimodal-Looker", mode: "subagent", permission: { look_at: "deny" } },
    },
    metadata: {
      global: {
        tools: {
          "grep_app_*": false,
          "task_*": false,
          teammate: false,
          LspHover: false,
          LspCodeActions: false,
          LspCodeActionResolve: false,
          skill_mcp: false,
        },
      },
    },
  }
}

async function registerPermissionAgents(wiring, manifest) {
  const agentDomain = {
    transform: async (callback) => {
      callback({ update: (_id, apply) => apply({ request: { headers: {}, body: {} }, permissions: [] }), default() {} })
      return { dispose() {} }
    },
    reload: async () => {},
  }
  await registerNativeAgents(agentDomain, manifest, {
    onAgentPermissions: (id, permissions) => wiring.onAgentPermissions(id, permissions),
  })
}

test("native runtime permission wiring blocks a denied call before the executor runs", async () => {
  const manifest = permissionManifest()
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  let executed = false
  const runTool = async (event) => { await wiring.before(event); executed = true }

  // Global grep_app_* deny with no agent override: the executor must not run.
  await expect(runTool({ tool: "grep_app_searchGitHub", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
  expect(executed).toBe(false)

  // The agent look_at deny is reachable by manifest id and by display name.
  await expect(wiring.before({ tool: "look_at", agent: "multimodal-looker" })).rejects.toThrow(/denied/)
  await expect(wiring.before({ tool: "look_at", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)

  // The legacy Lsp* names are denied by the translated global tools.
  await expect(wiring.before({ tool: "LspCodeActions", agent: "Sisyphus - ultraworker" })).rejects.toThrow(/denied/)

  // global teammate:false is a hard V1 catalog disable: the agent teammate
  // allow must not lift it.
  await expect(wiring.before({ tool: "team_create", agent: "Sisyphus - ultraworker" })).rejects.toThrow(/denied/)

  // An agent allow applies when global tools does not hard-disable the tool.
  await expect(wiring.before({ tool: "call_omo_agent", agent: "Sisyphus - ultraworker" })).resolves.toBeUndefined()

  // An agent with no override still receives the global team_* deny.
  await expect(wiring.before({ tool: "team_create", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
})

test("native runtime wildcard agent permission denies every concrete tool name except its allows", async () => {
  const manifest = {
    agents: {
      "multimodal-looker": { name: "Multimodal-Looker", mode: "subagent", permission: { "*": "deny", read: "allow" } },
    },
  }
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "read", agent: "Multimodal-Looker" })).resolves.toBeUndefined()
  await expect(wiring.before({ tool: "call_omo_agent", agent: "multimodal-looker" })).rejects.toThrow(/denied/)
  await expect(wiring.before({ tool: "future_non_native_tool", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
  await expect(wiring.before({ tool: "team_create", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
})

test("native runtime agent wildcard allow does not bypass a global hard-disable", async () => {
  const manifest = {
    agents: { sisyphus: { name: "Sisyphus - ultraworker", mode: "primary", permission: { "*": "allow" } } },
    metadata: { global: { tools: { call_omo_agent: false } } },
  }
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "call_omo_agent", agent: "Sisyphus - ultraworker" })).rejects.toThrow(/denied/)
  await expect(wiring.before({ tool: "look_at", agent: "Sisyphus - ultraworker" })).resolves.toBeUndefined()
})

test("native runtime permission wiring resolves the agent from the session when the event omits it", async () => {
  const manifest = permissionManifest()
  const seen = []
  const wiring = nativeRuntime.createNativePermissionWiring({
    manifest,
    resolveAgent: async ({ sessionID }) => { seen.push(sessionID); return "Multimodal-Looker" },
  })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "look_at", sessionID: "ses_child" })).rejects.toThrow(/denied/)
  expect(seen).toEqual(["ses_child"])
})

test("native runtime session resolver reads the agent from the V2 session surface", async () => {
  const calls = []
  const resolver = nativeRuntime.createSessionAgentResolver({
    session: { get: async (input) => { calls.push(input); return { data: { agent: "Multimodal-Looker" } } } },
  })
  await expect(resolver({ sessionID: "ses_child" })).resolves.toBe("Multimodal-Looker")
  expect(calls).toEqual([{ sessionID: "ses_child" }])
})

test("native runtime session resolver falls back to the client session surface and tolerates its absence", async () => {
  const paths = []
  const resolver = nativeRuntime.createSessionAgentResolver({
    client: { session: { get: async (input) => { paths.push(input); return { data: { agent: "Explore" } } } } },
  })
  await expect(resolver({ sessionID: "ses_child" })).resolves.toBe("Explore")
  expect(paths).toEqual([{ path: { id: "ses_child" } }])
  await expect(nativeRuntime.createSessionAgentResolver({})({ sessionID: "ses_child" })).resolves.toBeUndefined()
  await expect(nativeRuntime.createSessionAgentResolver({})({})).resolves.toBeUndefined()
})

test("native runtime permission wiring blocks an ask pending approval instead of allowing it", async () => {
  const manifest = { agents: { prometheus: { name: "Prometheus - Planner", permission: { call_omo_agent: "ask" } } } }
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "call_omo_agent", agent: "prometheus" })).rejects.toThrow(/approval/)
})

test("native runtime permission wiring fails closed only for a governed call with no agent identity", async () => {
  const manifest = permissionManifest()
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest, resolveAgent: async () => undefined })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "look_at", sessionID: "ses_1" })).rejects.toThrow(/identity/)
  await expect(wiring.before({ tool: "todo_write", sessionID: "ses_1" })).resolves.toBeUndefined()
})

test("native runtime registers one additional execute.before hook and disposes it", async () => {
  const registrations = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    session: {
      hook: async (name, handler) => {
        const registration = { name, handler, disposed: false, dispose() { registration.disposed = true } }
        registrations.push(registration)
        return registration
      },
    },
    tool: {
      transform: async (callback) => { callback({ add() {} }); return { dispose() {} } },
      hook: async (name, handler) => {
        const registration = { name, handler, disposed: false, dispose() { registration.disposed = true } }
        registrations.push(registration)
        return registration
      },
    },
  }
  const dispose = await plugin.setup(context)
  const beforeHooks = registrations.filter((registration) => registration.name === "execute.before")
  // Two pre-existing guards (write-existing-file + non-interactive env) plus
  // exactly one new permission gate.
  expect(beforeHooks.length).toBe(3)
  await dispose()
  expect(beforeHooks.every((registration) => registration.disposed)).toBe(true)
})
