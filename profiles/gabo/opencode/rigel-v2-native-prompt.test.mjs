import { expect, test } from "bun:test"
import { createNativeRequestHook } from "./rigel-v2-native-prompt.mjs"

test("request-stage roster is fresh, replaces an old roster, and preserves ordinary system text", async () => {
  let calls = 0
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => {
      calls += 1
      return calls === 1
        ? [{ name: "explore", mode: "subagent" }]
        : [{ name: "oracle", mode: "subagent" }]
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
  expect(body.messages[1].content).toContain('"explore"')

  await hook(input)
  body = await input.request.clone().json()
  expect(body.messages).toHaveLength(3)
  expect(body.messages[1].content).toContain('"oracle"')
  expect(body.messages[1].content).not.toContain('"explore"')
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
