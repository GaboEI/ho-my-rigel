import { expect, test } from "bun:test"
import { callableAgents } from "./rigel-v2-native-core.mjs"
import { createNativeRequestHook, formatDelegationRoster } from "./rigel-v2-native-prompt.mjs"

test("delegation roster renders each category's description and caller guidance", () => {
  const roster = formatDelegationRoster(
    [{ name: "explore", mode: "subagent" }],
    [
      { name: "quick", description: "Trivial tasks", callerGuidance: "<Caller_Warning>write explicit steps</Caller_Warning>" },
      { name: "my-lane", description: "Custom lane" },
    ],
  )
  expect(roster).toContain('"quick": Trivial tasks <Caller_Warning>write explicit steps</Caller_Warning>')
  expect(roster).toContain('"my-lane": Custom lane')
})

test("delegation roster still accepts bare category names", () => {
  const roster = formatDelegationRoster([{ name: "explore", mode: "subagent" }], ["quick"])
  expect(roster).toContain('- "quick"')
})

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

test("translates native agent request tuning into an OpenAI Responses provider payload", async () => {
  const observed = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [],
    getAgentRequestBody: () => ({
      temperature: 0.1,
      top_p: 0.8,
      maxTokens: 64000,
      thinking: { type: "enabled", budgetTokens: 32000 },
      reasoning: "high",
      textVerbosity: "low",
    }),
    onAgentTuningApplied: (event) => observed.push(event),
  })
  const input = {
    agent: "Sisyphus-Junior",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    request: new Request("https://example.invalid/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", input: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body).toMatchObject({
    temperature: 0.1,
    top_p: 0.8,
    max_output_tokens: 64000,
    thinking: { type: "enabled", budgetTokens: 32000 },
    reasoning: { effort: "high" },
    text: { verbosity: "low" },
  })
  expect(observed).toEqual([{
    agent: "Sisyphus-Junior",
    providerID: "opencode-go",
    shape: "responses",
    payload: {
      temperature: 0.1,
      top_p: 0.8,
      max_output_tokens: 64000,
      thinking: { type: "enabled", budgetTokens: 32000 },
      reasoning: { effort: "high" },
      text: { verbosity: "low" },
    },
  }])
})

test("translates legacy reasoningEffort and maxTokens into a Chat provider payload", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [],
    getAgentRequestBody: () => ({ reasoningEffort: "medium", maxTokens: 8192 }),
  })
  const input = {
    agent: "fixture",
    model: { providerID: "openai-compatible", id: "fixture" },
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect(await input.request.clone().json()).toMatchObject({
    max_tokens: 8192,
    reasoning_effort: "medium",
  })
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

test("resolves a fallback model at the request boundary when the primary is unavailable", async () => {
  const seen = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async (input) => {
      seen.push(input)
      return { providerID: "openai", id: "fallback-model" }
    },
  })
  const input = {
    sessionID: "ses_root",
    agent: "Sisyphus - ultraworker",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.model).toBe("fallback-model")
  expect(seen).toEqual([{ sessionID: "ses_root", agent: "Sisyphus - ultraworker", model: "primary-model", sameProviderAs: "openai" }])
  expect(body.messages.some((message) => message.content?.includes("<rigel-native-delegation-roster>"))).toBe(true)
})

test("keeps the payload model when the resolver returns the current model", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => ({ providerID: "openai", id: "primary-model" }),
  })
  const input = {
    sessionID: "ses_root",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("primary-model")
})

test("applies model fallback to a child session without injecting the roster", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
    resolveModel: async () => ({ providerID: "openai", id: "child-fallback" }),
  })
  const input = {
    sessionID: "ses_child",
    agent: "explore",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "child work" }] }),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.model).toBe("child-fallback")
  expect(body.messages).toEqual([{ role: "user", content: "child work" }])
})

test("leaves the payload model untouched when the active provider is unknown", async () => {
  let calls = 0
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => { calls += 1; return { providerID: "openai", id: "fallback-model" } },
  })
  const input = {
    sessionID: "ses_root",
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("primary-model")
  expect(calls).toBe(0)
})

test("passes the V2 request provider to the resolver as sameProviderAs", async () => {
  const seen = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async (input) => { seen.push(input); return undefined },
  })
  const input = {
    sessionID: "ses_root",
    agent: "explore",
    model: { providerID: "openai", modelID: "primary" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect(seen).toEqual([{ sessionID: "ses_root", agent: "explore", model: "primary-model", sameProviderAs: "openai" }])
})

test("a resolver failure leaves the request body untouched", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => { throw new Error("inventory down") },
  })
  const input = {
    sessionID: "ses_root",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("primary-model")
})

// The live V2 lab sends the OpenAI Responses API shape: `input` (typed items)
// plus a single `instructions` string, and NO `messages` array. These tests pin
// that the hook no longer bails on the shape guard and that both the model
// fallback and the roster injection reach that body.
function responsesBody(overrides = {}) {
  return {
    model: "grok-4.7",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "research this" }] },
    ],
    instructions: "You are a helpful agent.",
    tools: [],
    store: false,
    prompt_cache_key: "ses_root",
    include: [],
    max_output_tokens: 4096,
    stream: true,
    ...overrides,
  }
}

test("rewrites the model for a Responses-shaped body and leaves input and instructions intact", async () => {
  const seen = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async (input) => { seen.push(input); return { providerID: "opencode-go", id: "kimi-k3" } },
  })
  const original = responsesBody()
  const input = {
    sessionID: "ses_root",
    agent: "explore",
    model: { providerID: "opencode-go", modelID: "grok-4.7" },
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(original),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.model).toBe("kimi-k3")
  expect(seen).toEqual([{ sessionID: "ses_root", agent: "explore", model: "grok-4.7", sameProviderAs: "opencode-go" }])
  expect(body.input).toEqual(original.input)
  expect(body.instructions).toContain("You are a helpful agent.")
  expect(body.instructions).toContain("<rigel-native-delegation-roster>")
  expect(body.prompt_cache_key).toBe("ses_root")
  expect(body.max_output_tokens).toBe(4096)
})

test("keeps the Responses model when the resolver returns the current model", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => ({ providerID: "opencode-go", id: "grok-4.7" }),
  })
  const input = {
    sessionID: "ses_root",
    model: { providerID: "opencode-go", modelID: "grok-4.7" },
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody()),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("grok-4.7")
})

test("does not inject the roster into a Responses-shaped child session", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
  })
  const original = responsesBody()
  const input = {
    sessionID: "ses_child",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(original),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.input).toEqual(original.input)
  expect(body.instructions).toBe("You are a helpful agent.")
})

test("appends directory guidance to Responses instructions for a child session", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
    getDirectoryInstructions: () => "<rigel-native-directory-agents>\nAGENTS rules\n<rigel-native-directory-agents>",
  })
  const input = {
    sessionID: "ses_child",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody()),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.instructions).toContain("You are a helpful agent.")
  expect(body.instructions).toContain("<rigel-native-directory-agents>")
  expect(body.input).toHaveLength(1)
})

test("Responses instructions do not accumulate across repeated passes", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    ultraworkPrompt: "<ultrawork-mode>ULTRAWORK MODE ENABLED!</ultrawork-mode>",
  })
  const input = {
    sessionID: "ses_root",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ulw investigate" }] }] })),
    }),
  }
  await hook(input)
  const first = (await input.request.clone().json()).instructions
  expect(first).toContain("ULTRAWORK MODE ENABLED!")
  expect(first).toContain("<rigel-native-delegation-roster>")

  input.request = new Request("https://example.invalid/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(responsesBody({ instructions: first, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }] })),
  })
  await hook(input)
  const second = (await input.request.clone().json()).instructions
  expect((second.match(/ULTRAWORK MODE ENABLED!/g) ?? [])).toHaveLength(1)
  expect((second.match(/<rigel-native-delegation-roster>/g) ?? [])).toHaveLength(2)
  expect(second).toContain("You are a helpful agent.")
})

test("renders the delegation roster with the canonical core head from a shuffled inventory", async () => {
  const inventory = [
    { id: "judge", name: "Judge", mode: "all" },
    { id: "atlas", name: "Atlas - Plan Executor", mode: "all" },
    { id: "explore", name: "Explore", mode: "subagent" },
    { id: "prometheus", name: "Prometheus - Plan Builder", mode: "all" },
    { id: "sisyphus", name: "Sisyphus - ultraworker", mode: "all" },
  ]
  const hook = createNativeRequestHook({ getDelegationRoster: async () => callableAgents({ data: inventory }) })
  const input = {
    kind: "primary",
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "delegate this" }] }),
    }),
  }
  await hook(input)
  const content = (await input.request.clone().json()).messages
    .map((message) => message.content)
    .find((value) => typeof value === "string" && value.includes("<rigel-native-delegation-roster>"))
  const rows = [...content.matchAll(/^- "([^"]+)":/gm)].map((match) => match[1])
  expect(rows).toEqual([
    "Sisyphus - ultraworker",
    "Prometheus - Plan Builder",
    "Atlas - Plan Executor",
    "Judge",
    "Explore",
  ])
})
