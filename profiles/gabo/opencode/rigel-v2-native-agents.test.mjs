import { expect, test } from "bun:test"
import { applyLegacyAgentDefinition, nativePermissionRules, registerNativeAgents, resolveProactiveAgentModels } from "./rigel-v2-native-agents.mjs"

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
