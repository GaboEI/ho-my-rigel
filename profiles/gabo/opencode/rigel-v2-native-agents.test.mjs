import { expect, test } from "bun:test"
import { applyLegacyAgentDefinition, nativePermissionRules } from "./rigel-v2-native-agents.mjs"

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
