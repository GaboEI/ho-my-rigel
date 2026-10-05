import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./rigel-v2-native.mjs"
import * as nativeRuntime from "./rigel-v2-native.mjs"
import nativeManifest from "./rigel-v2-native-agent-manifest.mjs"
import { registerNativeAgents } from "./rigel-v2-native-agents.mjs"
import { INTERRUPTED_TOOL_ERROR } from "./rigel-v2-flow-logic.mjs"
import { CONTINUATION_PROMPT_MARKER } from "./rigel-v2-native-request-steps.mjs"

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
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } })
      return { dispose() {} }
    } },
  }
  const dispose = await plugin.setup(context)
  expect(definition.description).toContain("active V2 agent inventory")
  expect(definition.description).not.toContain("Available named specialists:")
  // Strict Responses-API tool-schema validation rejects a parameter whose root
  // is an anyOf/oneOf union ("rigel_task: tool parameter root must be an object
  // type"); the root must be a plain object schema. Live: grok-4.7/grok-4.6.
  expect(definition.input.type).toBe("object")
  expect(definition.input.anyOf).toBeUndefined()
  expect(definition.input.oneOf).toBeUndefined()
  // Background delegation now requires a parent session so admission can key and
  // track the queued/active child. Without one it is rejected before any create.
  await expect(definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, {})).rejects.toThrow("requires a parent session")
  // inventory resolution is the only call so far; no child was created
  expect(calls.filter((call) => call[0] === "create")).toEqual([])
  const result = await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })
  expect(result.metadata).toMatchObject({ sessionID: "ses_native", agent: "Explore", background: true })
  expect(calls.slice(0, 3)).toEqual([
    ["agents", { directory: "/native-v2" }],
    ["agents", { directory: "/native-v2" }],
    ["create", { agent: "explore", location: { directory: "/native-v2" }, parentID: "ses_parent" }],
  ])
  expect(calls[3][0]).toBe("prompt")
  expect(calls[3][1].sessionID).toBe("ses_native")
  expect(calls[3][1].resume).toBe(true)
  // The child prompt carries the taskId nonce used to reconcile the starting
  // crash window without re-creating the child.
  expect(calls[3][1].text).toContain("<rigel-task-id>")
  expect(calls[3][1].text).toContain("Read only.")
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
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } })
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
    tool: { transform: async (callback) => { callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } }); return { dispose() {} } } },
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
    tool: { transform: async (callback) => { callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } }); return { dispose() {} } } },
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
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value }, get: () => definition })
      if (definition) feed.definition = definition
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

// Task 11: the runtime composes two ordered tool-hook chains. The recording
// fake observes the registrations in order, and driving a chain returns the
// boundary report from `runOrderedRules`, so the observed hook and rule
// sequences are the real ones instead of a bare handler count.
function recordingHookContext(directory = "/native-v2") {
  const registrations = []
  const record = (name, handler) => {
    const registration = { name, handler, disposed: false, dispose() { registration.disposed = true } }
    registrations.push(registration)
    return registration
  }
  const context = {
    location: { directory },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    session: { hook: async (name, handler) => record(name, handler) },
    tool: {
      transform: async (callback) => { callback({ add() {} }); return { dispose() {} } },
      hook: async (name, handler) => record(name, handler),
    },
  }
  return { context, registrations }
}

test("native runtime registers its ordered tool hook chain and disposes every registration", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rigel-native-hook-order-"))
  try {
    const { context, registrations } = recordingHookContext(workspace)
    const dispose = await plugin.setup(context)

    // Observed from the recording tool.hook/session.hook fake: two
    // execute.after handlers (directory instructions, then the ordered result
    // chain), three execute.before handlers (the ordered write-guard chain,
    // the non-interactive env guard, the permission gate), and one
    // http.request pipeline, in that exact order.
    expect(registrations.map((registration) => registration.name)).toEqual([
      "execute.after",
      "execute.after",
      "execute.before",
      "execute.before",
      "execute.before",
      "http.request",
    ])

    // Driving the after chain returns the boundary report: every rule ran in
    // the declared order and none was isolated. The T14 flow rules are appended
    // after the eight built-in result transforms.
    const afterChain = registrations.filter((registration) => registration.name === "execute.after")
    const afterReport = await afterChain[1].handler({
      status: "completed",
      tool: "read",
      sessionID: "ses_order",
      input: { filePath: "notes.md" },
      result: { content: "file text" },
    })
    expect(afterReport.executed).toEqual([
      "hashline-read-enhancer",
      "tool-result-reminders",
      "category-skill-reminder",
      "recovery-reminder",
      "rules-injector",
      "comment-checker",
      "plan-format-validator",
      "webfetch-redirect-guard",
      "delegate-task-retry",
      "fsync-skip-warning",
    ])
    expect(afterReport.failures).toEqual([])

    // The before chain composes the four built-in rules followed by the T13
    // guard rules and the T14 fsync start rule, in that declared order.
    const beforeChain = registrations.filter((registration) => registration.name === "execute.before")
    const beforeReport = await beforeChain[0].handler({
      tool: "read",
      sessionID: "ses_order",
      id: "call_order",
      input: { filePath: "notes.md" },
    })
    expect(beforeReport.executed).toEqual([
      "prometheus-md-only",
      "write-existing-file-guard",
      "comment-checker",
      "webfetch-redirect-guard",
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "fsync-skip-warning:record-start",
    ])
    expect(beforeReport.failures).toEqual([])

    await dispose()
    expect(registrations.every((registration) => registration.disposed)).toBe(true)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("native runtime isolates a throwing execute.before rule and keeps the chain running", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rigel-native-hook-isolation-"))
  const existing = join(workspace, "existing.txt")
  writeFileSync(existing, "already here\n")
  try {
    const { context, registrations } = recordingHookContext(workspace)
    const dispose = await plugin.setup(context)
    const beforeChain = registrations.filter((registration) => registration.name === "execute.before")

    // The second rule, the write-existing-file guard, throws for a write to an
    // existing file. The chain must resolve anyway, record the failure, and
    // still run the comment-checker and webfetch rules declared after it, plus
    // every T13/T14 flow rule appended at the end.
    const report = await beforeChain[0].handler({
      tool: "write",
      sessionID: "ses_guard",
      id: "call_guard",
      input: { filePath: existing, content: "// a comment\nconst value = 1\n" },
    })

    expect(report.failures.map((failure) => failure.name)).toEqual(["write-existing-file-guard"])
    expect(report.failures[0].error).toBeInstanceOf(Error)
    expect(report.executed).toEqual([
      "prometheus-md-only",
      "comment-checker",
      "webfetch-redirect-guard",
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "fsync-skip-warning:record-start",
    ])

    await dispose()
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("native runtime isolates a throwing flow rule and keeps the composed before chain running", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rigel-native-flow-isolation-"))
  try {
    const { context, registrations } = recordingHookContext(workspace)
    const dispose = await plugin.setup(context)
    const beforeChain = registrations.filter((registration) => registration.name === "execute.before")

    // notepad-write-guard is the first T13 flow rule and throws for a write
    // into a notepad root. The four native rules before it already completed,
    // and every flow rule declared after it must still run.
    const report = await beforeChain[0].handler({
      tool: "write",
      sessionID: "ses_flow",
      id: "call_flow",
      input: { filePath: join(workspace, ".omo", "notepads", "plan.md"), content: "notes\n" },
    })

    expect(report.failures.map((failure) => failure.name)).toEqual(["notepad-write-guard"])
    expect(report.failures[0].error).toBeInstanceOf(Error)
    expect(report.executed).toEqual([
      "prometheus-md-only",
      "write-existing-file-guard",
      "comment-checker",
      "webfetch-redirect-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "fsync-skip-warning:record-start",
    ])
    await dispose()
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("native runtime composes the request steps into the single http.request handler", async () => {
  const { context, registrations } = recordingHookContext()
  const dispose = await plugin.setup(context)

  // The flow steps share the one existing registration; no second
  // `http.request` handler is opened.
  const requestHandlers = registrations.filter((registration) => registration.name === "http.request")
  expect(requestHandlers).toHaveLength(1)

  const input = {
    sessionID: "ses_request",
    agent: "sisyphus",
    model: { providerID: "opencode-go", modelID: "gpt-6-luna-fast" },
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna-fast",
        messages: [
          { role: "assistant", content: null, tool_calls: [{ id: "call_orphan", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "user", content: CONTINUATION_PROMPT_MARKER },
          { role: "user", content: "/stop-continuation" },
        ],
      }),
    }),
  }
  await requestHandlers[0].handler(input)

  const body = await input.request.clone().json()
  // Step 1: the orphaned assistant tool call gains its terminal result.
  const repaired = body.messages.find((message) => message.role === "tool")
  expect(repaired).toMatchObject({ tool_call_id: "call_orphan", content: INTERRUPTED_TOOL_ERROR })
  // Step 2: the stop command marks the session and the queued continuation is
  // stripped from the same body, while the stop command itself stays.
  expect(body.messages.some((message) => typeof message.content === "string"
    && message.content.includes(CONTINUATION_PROMPT_MARKER))).toBe(false)
  expect(body.messages.some((message) => message.content === "/stop-continuation")).toBe(true)
  await dispose()
})

test("native runtime clears the stop-continuation state when the session is deleted", async () => {
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed)
  const dispose = await plugin.setup(context)

  const request = (messages) => ({
    sessionID: "ses_child",
    agent: "explore",
    model: { providerID: "opencode-go", modelID: "grok-4.7" },
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.7", messages }),
    }),
  })

  const stopped = request([
    { role: "user", content: CONTINUATION_PROMPT_MARKER },
    { role: "user", content: "/stop-continuation" },
  ])
  await feed.requestHook(stopped)
  const stoppedBody = await stopped.request.clone().json()
  expect(stoppedBody.messages.some((message) => typeof message.content === "string"
    && message.content.includes(CONTINUATION_PROMPT_MARKER))).toBe(false)

  const deleted = feed.consumed()
  feed.push({ type: "session.deleted", data: { sessionID: "ses_child" } })
  await deleted

  // The stop flag is gone, so a queued continuation is no longer stripped.
  const resumed = request([{ role: "user", content: CONTINUATION_PROMPT_MARKER }])
  await feed.requestHook(resumed)
  const resumedBody = await resumed.request.clone().json()
  expect(resumedBody.messages.some((message) => typeof message.content === "string"
    && message.content.includes(CONTINUATION_PROMPT_MARKER))).toBe(true)
  await dispose()
})

test("native runtime clears the flow state on dispose", async () => {
  const { context, registrations } = recordingHookContext()
  const dispose = await plugin.setup(context)
  const handler = registrations.find((registration) => registration.name === "http.request").handler

  const request = (messages) => ({
    sessionID: "ses_dispose",
    agent: "sisyphus",
    model: { providerID: "opencode-go", modelID: "gpt-6-luna-fast" },
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna-fast", messages }),
    }),
  })

  const stopped = request([
    { role: "user", content: CONTINUATION_PROMPT_MARKER },
    { role: "user", content: "/stop-continuation" },
  ])
  await handler(stopped)
  const stoppedBody = await stopped.request.clone().json()
  expect(stoppedBody.messages.some((message) => typeof message.content === "string"
    && message.content.includes(CONTINUATION_PROMPT_MARKER))).toBe(false)

  await dispose()

  // The disposed runtime holds no stopped session, so the queued continuation
  // survives the same handler.
  const resumed = request([{ role: "user", content: CONTINUATION_PROMPT_MARKER }])
  await handler(resumed)
  const resumedBody = await resumed.request.clone().json()
  expect(resumedBody.messages.some((message) => typeof message.content === "string"
    && message.content.includes(CONTINUATION_PROMPT_MARKER))).toBe(true)
})

test("native runtime clears a deleted session's background child so no wake is delivered", async () => {
  const prompts = []
  const feed = createEventFeed()
  let definition
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "http.request") feed.requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "EVIDENCE" }] }],
      prompt: async (input) => { prompts.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => { callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } }); return { dispose() {} } } },
  }
  const dispose = await plugin.setup(context)
  await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })

  const deleted = feed.consumed()
  feed.push({ type: "session.deleted", data: { sessionID: "ses_child" } })
  await deleted

  // If the registry had not cleared the deleted session's background child,
  // this success would have prompted the parent with the child's result.
  const succeeded = feed.consumed()
  feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
  await succeeded

  // The child's own task prompt is expected; the parent wake is not.
  expect(prompts.filter((input) => input.sessionID === "ses_parent")).toEqual([])
  await dispose()
})

// Task 19: the hashline edit tool is registered only when the materialized
// `hashline_edit` gate is on. The runtime reads the manifest singleton at setup
// time, so the gated case turns the gate on for the duration of one setup and
// restores it; the negative control exercises the shipped default manifest,
// whose gate is absent.
function editorCaptureContext() {
  const added = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_native" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => added.push(definition?.name), get: () => undefined })
        return { dispose() {} }
      },
    },
  }
  return { context, added }
}

test("native runtime registers hashline_edit when the manifest gate is on", async () => {
  // The generator replaces the manifest default export with the materialized
  // gates at installation time. Mutate the shared manifest object the runtime
  // reads, then restore it, so the gated registration runs against a real
  // setup instead of a fixture-only editor.
  const originalMetadata = nativeManifest.metadata
  nativeManifest.metadata = { global: { gates: { hashline_edit: true } } }
  try {
    const { context, added } = editorCaptureContext()
    const dispose = await plugin.setup(context)
    expect(added).toContain("hashline_edit")
    await dispose()
  } finally {
    if (originalMetadata === undefined) delete nativeManifest.metadata
    else nativeManifest.metadata = originalMetadata
  }
})

test("native runtime omits hashline_edit when the manifest gate is absent", async () => {
  const { context, added } = editorCaptureContext()
  const dispose = await plugin.setup(context)
  expect(added).toContain("rigel_task")
  expect(added).not.toContain("hashline_edit")
  await dispose()
})

// Task 19: a real compaction clears the file-read-scoped context and writes an
// observable receipt under $XDG_STATE_HOME. The event feed resolves only after
// the runtime finished handling the pushed event, so awaiting it is the
// synchronization point.
test("native runtime records a context-cleared receipt on compaction", async () => {
  const previousStateHome = process.env.XDG_STATE_HOME
  const stateRoot = mkdtempSync(join(tmpdir(), "rigel-native-runtime-"))
  process.env.XDG_STATE_HOME = stateRoot
  try {
    const feed = createEventFeed()
    const context = reactiveFallbackContext(feed)
    const dispose = await plugin.setup(context)

    const consumed = feed.consumed()
    feed.push({ type: "session.compacted", data: { sessionID: "ses_compact" } })
    await consumed

    const receiptPath = join(stateRoot, "oh-my-rigel", "context-cleared-on-compaction.json")
    expect(existsSync(receiptPath)).toBe(true)
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      sessionID: "ses_compact",
      eventType: "session.compacted",
    })
    await dispose()
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    rmSync(stateRoot, { recursive: true, force: true })
  }
})

// Task 19: the live V2 stream delivers compaction as `session.compaction.*`
// with the session id under `properties`, so the handler must accept that name
// and shape too, not only `session.compacted` with `data.sessionID`.
test("native runtime records the clear for the streamed compaction event name", async () => {
  const previousStateHome = process.env.XDG_STATE_HOME
  const stateRoot = mkdtempSync(join(tmpdir(), "rigel-native-runtime-compaction-stream-"))
  process.env.XDG_STATE_HOME = stateRoot
  try {
    const feed = createEventFeed()
    const context = reactiveFallbackContext(feed)
    const dispose = await plugin.setup(context)
    const consumed = feed.consumed()
    feed.push({ type: "session.compaction.started", properties: { sessionID: "ses_compact_stream" } })
    await consumed
    const receipt = JSON.parse(readFileSync(join(stateRoot, "oh-my-rigel", "context-cleared-on-compaction.json"), "utf8"))
    expect(receipt).toMatchObject({ sessionID: "ses_compact_stream", eventType: "session.compaction.started" })
    await dispose()
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    rmSync(stateRoot, { recursive: true, force: true })
  }
})

test("native runtime reads keyword_detector disabled and enabled lists from the merged plugin config", () => {
  // given / when / then
  expect(nativeRuntime.readKeywordDetectorConfig({
    config: { keyword_detector: { disabled_keywords: ["team"], enabled_expansions: ["ultrawork", "hyperplan"] } },
  })).toEqual({ disabledKeywords: ["team"], enabledExpansions: ["ultrawork", "hyperplan"] })
  expect(nativeRuntime.readKeywordDetectorConfig({})).toEqual({})
  expect(nativeRuntime.readKeywordDetectorConfig({ config: { keyword_detector: Array.of("bad") } })).toEqual({})
  expect(nativeRuntime.readKeywordDetectorConfig({ config: { keyword_detector: { disabled_keywords: "team" } } }))
    .toEqual({ disabledKeywords: undefined, enabledExpansions: undefined })
})
