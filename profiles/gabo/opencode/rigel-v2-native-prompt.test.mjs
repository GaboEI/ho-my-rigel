import { expect, test } from "bun:test"
import { createNativeRequestHook } from "./rigel-v2-native-prompt.mjs"

test("request-stage roster recovers from the startup two-agent race and replaces stale entries", async () => {
  let calls = 0
  const loadedAfterStartup = [
    "General", "Explore", "Sisyphus - ultraworker", "Prometheus - Plan Builder",
    "Atlas - Plan Executor", "explore", "librarian", "oracle", "Metis - Plan Consultant",
    "Momus - Plan Critic", "multimodal-looker", "Sisyphus-Junior", "judge", "forja",
    "researcher", "reviewer", "writer", "architect",
  ].map((name) => ({ name, mode: "subagent" }))
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => {
      calls += 1
      return calls === 1
        ? [{ name: "General", mode: "subagent" }, { name: "Explore", mode: "subagent" }]
        : loadedAfterStartup
    },
    categories: ["quick"],
  })
  const input = {
    kind: "primary",
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [
        { role: "system", content: "ordinary system text" },
        { role: "user", content: "research this" },
      ] }),
    }),
  }
  await hook(input)
  let body = await input.request.clone().json()
  expect(body.messages).toHaveLength(3)
  expect(body.messages[0]).toEqual({ role: "system", content: "ordinary system text" })
  expect(body.messages[1].content).toContain('"General"')
  expect(body.messages[1].content).toContain('"Explore"')
  expect(body.messages[1].content).not.toContain('"librarian"')

  await hook(input)
  body = await input.request.clone().json()
  expect(body.messages).toHaveLength(3)
  expect(body.messages[1].content).toContain('"librarian"')
  expect(body.messages[1].content).toContain('"judge"')
  expect(body.messages[1].content).toContain('"architect"')
  expect((body.messages[1].content.match(/^-/gm) ?? [])).toHaveLength(19)
  expect(calls).toBe(2)
})

test("request-stage roster is never injected into a child session", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
  })
  const input = {
    kind: "primary",
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "child work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).messages).toEqual([{ role: "user", content: "child work" }])
})

test("Ultrawork aliases activate a persistent root-only native prompt", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    ultraworkPrompt: "<ultrawork-mode>ULTRAWORK MODE ENABLED!</ultrawork-mode>",
  })
  const input = {
    sessionID: "ses_root",
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Ultraworker: investigate this" }] }),
    }),
  }
  await hook(input)
  let body = await input.request.clone().json()
  expect(body.messages.some((message) => message.content?.includes("ULTRAWORK MODE ENABLED!"))).toBe(true)

  input.request = new Request("https://example.invalid/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "continue" }] }),
  })
  await hook(input)
  body = await input.request.clone().json()
  expect(body.messages.some((message) => message.content?.includes("ULTRAWORK MODE ENABLED!"))).toBe(true)
})

test("default Ultrawork activates for roots and never leaks into children", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    defaultUltrawork: true,
    ultraworkPrompt: "<ultrawork-mode>DEFAULT ULTRAWORK</ultrawork-mode>",
  })
  const root = { sessionID: "ses_root", request: new Request("https://example.invalid/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "ordinary work" }] }) }) }
  await hook(root)
  expect((await root.request.clone().json()).messages.some((message) => message.content?.includes("DEFAULT ULTRAWORK"))).toBe(true)

  const childHook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    defaultUltrawork: true,
    ultraworkPrompt: "<ultrawork-mode>DEFAULT ULTRAWORK</ultrawork-mode>",
    isRootSession: async () => false,
  })
  const child = { sessionID: "ses_child", request: new Request("https://example.invalid/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "child work" }] }) }) }
  await childHook(child)
  expect((await child.request.clone().json()).messages).toEqual([{ role: "user", content: "child work" }])
})
