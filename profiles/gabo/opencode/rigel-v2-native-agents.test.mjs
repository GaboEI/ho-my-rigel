import { expect, test } from "bun:test"
import { agentRequestBodyFromDefinition, applyLegacyAgentDefinition, nativePermissionRules, registerNativeAgents, resolveProactiveAgentModels } from "./rigel-v2-native-agents.mjs"

test("converts V1 agent fields to native V2 Agent.Info fields", () => {
  const agent = { request: { headers: {}, body: {} }, permissions: [] }
  applyLegacyAgentDefinition(agent, "judge", {
    name: "Judge", mode: "primary", prompt: "Audit.", model: "openai/gpt-test", variant: "high",
    permission: { read: "allow", edit: "deny", task: "ask", bash: { "*": "ask" } },
  })
  expect(agent).toMatchObject({
    name: "Judge", mode: "primary", hidden: false, system: "Audit.",
    model: { providerID: "openai", id: "gpt-test", variant: "high" },
  })
  expect(agent.permissions).toEqual([
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "ask" },
  ])
})

test("does not invent permission rules from malformed legacy input", () => {
  expect(nativePermissionRules({ edit: { "*": "deny", nope: 42 }, bad: null })).toEqual([
    { action: "edit", resource: "*", effect: "deny" },
  ])
})

test("maps canonical manifest tuning fields into the native AgentV2Info request body", () => {
  expect(agentRequestBodyFromDefinition({
    temperature: 0.2,
    top_p: 0.85,
    maxTokens: 64000,
    thinking: { type: "enabled", budgetTokens: 32000 },
    reasoning: "high",
    textVerbosity: "low",
  })).toEqual({
    temperature: 0.2,
    top_p: 0.85,
    maxTokens: 64000,
    thinking: { type: "enabled", budgetTokens: 32000 },
    reasoning: "high",
    textVerbosity: "low",
  })
})

test("maps the legacy reasoningEffort alias when reasoning is absent", () => {
  expect(agentRequestBodyFromDefinition({ reasoningEffort: "medium" })).toEqual({ reasoningEffort: "medium" })
})

test("rejects simultaneous reasoning aliases instead of discarding one", () => {
  expect(() => agentRequestBodyFromDefinition({ reasoning: "high", reasoningEffort: "medium" }))
    .toThrow("Conflicting native agent tuning fields: reasoning and reasoningEffort")
})

test("rejects malformed manifest tuning instead of dropping it silently", () => {
  expect(() => agentRequestBodyFromDefinition({ maxTokens: "64000" })).toThrow("maxTokens")
  expect(() => agentRequestBodyFromDefinition({ textVerbosity: "verbose" })).toThrow("textVerbosity")
})

test("proactive resolution starts an agent on the first available chain rung before reload", () => {
  // `explore`'s canonical chain is kimi, then openai gpt-6-luna-fast. The
  // kimi provider is absent from the inventory, so the pre-selection resolver
  // must pick the openai rung, not the manifest's raw model.
  const manifest = {
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const inventory = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]
  const resolved = resolveProactiveAgentModels(manifest.agents, inventory)
  expect(resolved.get("explore")).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("proactive resolution prefers an earlier canonical rung over an available manifest rung", () => {
  const manifest = {
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "openai/gpt-6-luna-fast", variant: "low" },
    },
  }
  const inventory = [
    { providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", enabled: true },
    { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
  ]
  const resolved = resolveProactiveAgentModels(manifest.agents, inventory)
  expect(resolved.get("explore")).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

test("proactive resolution falls back to the manifest model when the inventory is unavailable", () => {
  const manifest = {
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const resolved = resolveProactiveAgentModels(manifest.agents, undefined)
  expect(resolved.get("explore")).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

test("registerNativeAgents applies the proactive model before agent.reload", async () => {
  const timeline = []
  const applied = {}
  const editor = {
    update(id, callback) {
      const agent = { request: { headers: {}, body: {} }, permissions: [] }
      callback(agent)
      applied[id] = agent.model
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { timeline.push("transform"); callback(editor); return { dispose() {} } },
    reload: async () => { timeline.push("reload") },
  }
  const manifest = {
    defaultAgent: "explore",
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }],
  })
  expect(registered).toEqual(["explore"])
  // The model is the resolved rung, and it lands before reload runs.
  expect(applied.explore).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
  expect(timeline).toEqual(["transform", "reload"])
})

test("registerNativeAgents keeps manifest models when the inventory read fails", async () => {
  const applied = {}
  const editor = {
    update(id, callback) {
      const agent = { request: { headers: {}, body: {} }, permissions: [] }
      callback(agent)
      applied[id] = agent.model
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { callback(editor); return { dispose() {} } },
    reload: async () => {},
  }
  const manifest = {
    agents: { explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" } },
  }
  await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => { throw new Error("inventory down") },
  })
  expect(applied.explore).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

test("registerNativeAgents exposes acceptance tuning from the applied AgentV2Info request bodies", async () => {
  const requests = new Map()
  const editor = {
    update(_id, callback) {
      callback({ request: { settings: {}, headers: {}, body: {} }, permissions: [] })
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { callback(editor); return { dispose() {} } },
    reload: async () => {},
  }
  await registerNativeAgents(agentDomain, {
    agents: {
      "Sisyphus-Junior": { name: "Sisyphus-Junior", maxTokens: 64000 },
      "Atlas - Plan Executor": { name: "Atlas - Plan Executor", temperature: 0.1 },
    },
  }, {
    onAgentRequest: (id, body) => requests.set(id, body),
  })
  expect(requests.get("Sisyphus-Junior")).toMatchObject({ maxTokens: 64000 })
  expect(requests.get("Atlas - Plan Executor")).toMatchObject({ temperature: 0.1 })
})
