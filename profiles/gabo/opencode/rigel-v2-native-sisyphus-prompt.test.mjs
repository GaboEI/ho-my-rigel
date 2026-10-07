import { describe, expect, test } from "bun:test"

import { createNativeContextHook } from "./rigel-v2-native-prompt.mjs"
import {
  SISYPHUS_AGENT_ID,
  SISYPHUS_FORMAT_EXAMPLE_PROVENANCE,
  SISYPHUS_PROMPT_IDENTITY_MODELS,
  applySisyphusFormatExampleFix,
  createSisyphusPromptReconciler,
  createSisyphusPromptReconcilerFromManifest,
  disposeBakeHooks,
  extractModelName,
  fixSisyphusAgentMap,
  isSisyphusAgent,
  readSisyphusPromptPlan,
  resolveGptPromptIdentityBucket,
} from "./rigel-v2-native-sisyphus-prompt.mjs"
import { getGptPromptIdentityKey } from "../../../packages/omo-opencode/src/agents/gpt-prompt-identity.ts"

// Synthetic, clearly-labelled bodies. The contract under test is the model-keyed
// swap, not prompt prose, so short distinguishable strings are the honest fixture.
const BAKED_MODEL = "opencode-go/deepseek-v4.1-flash"
const BAKED_BODY = "BODY(deepseek-fallback)"
const CLAUDE_MODEL = "claude-opus-5-5"
const CLAUDE_BODY = "BODY(claude-opus-5)"
const KIMI_MODEL = "kimi-k3"
const KIMI_BODY = "BODY(kimi-k3)"
const ASTRA_BODY = "BODY(gpt-6-astra)"
const GPT_SOL_BODY = "BODY(gpt-6-sol)"

function plan(overrides = {}) {
  return {
    bakedModel: BAKED_MODEL,
    bakedPrompt: BAKED_BODY,
    promptByModel: {
      "deepseek-v4.1-flash": BAKED_BODY,
      [CLAUDE_MODEL]: CLAUDE_BODY,
      [KIMI_MODEL]: KIMI_BODY,
      "gpt-6-astra": ASTRA_BODY,
      "gpt-6-sol": GPT_SOL_BODY,
    },
    ...overrides,
  }
}

describe("native Sisyphus prompt reconciliation (#5297/#5316/#6966)", () => {
  test("#given a fallback-baked body #when the runtime model is another family #then the whole body is swapped", () => {
    // given
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    const verdict = reconcile(system, CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID })

    // then
    expect(verdict.reconciled).toBe(true)
    expect(system[0].text).toBe(CLAUDE_BODY)
  })

  test("#given the body wrapped in surrounding system text #when reconciled #then only the body portion changes", () => {
    // given
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    const system = [{ type: "text", text: `<system-wrapper>\n${BAKED_BODY}\n</system-wrapper>` }]

    // when
    reconcile(system, CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID })

    // then
    expect(system[0].text).toContain("<system-wrapper>")
    expect(system[0].text).toContain("</system-wrapper>")
    expect(system[0].text).not.toContain(BAKED_BODY)
    expect(system[0].text).toContain(CLAUDE_BODY)
  })

  test("#given the runtime model equals the baked model #when reconciled #then the body is left untouched", () => {
    // given
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    const verdict = reconcile(system, "opencode-go/deepseek-v4.1-flash", { agent: SISYPHUS_AGENT_ID })

    // then
    expect(verdict).toEqual({ reconciled: false, reason: "configured-model" })
    expect(system[0].text).toBe(BAKED_BODY)
  })

  test("#given the body is byte-identical for the runtime model #when reconciled #then the no-op is suppressed", () => {
    // given: a second model whose registration body equals the baked one
    const reconcile = createSisyphusPromptReconciler(plan({
      promptByModel: { "deepseek-v4.1-flash": BAKED_BODY, "minimax-m3": BAKED_BODY },
    })).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    const verdict = reconcile(system, "minimax-m3", { agent: SISYPHUS_AGENT_ID })

    // then
    expect(verdict.reason).toBe("uniform")
    expect(system[0].text).toBe(BAKED_BODY)
  })

  test("#given a model outside the baked set #when reconciled #then nothing changes and the miss is reported", () => {
    // given
    const events = []
    const reconcile = createSisyphusPromptReconciler(plan({ onReconcile: (e) => events.push(e) })).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    const verdict = reconcile(system, "some-unbaked-model", { agent: SISYPHUS_AGENT_ID })

    // then
    expect(verdict).toEqual({ reconciled: false, reason: "model-not-baked" })
    expect(system[0].text).toBe(BAKED_BODY)
    expect(events).toEqual([{ agent: SISYPHUS_AGENT_ID, runtimeModel: "some-unbaked-model", reconciled: false, reason: "model-not-baked" }])
  })

  test("#given a non-Sisyphus agent #when reconciled #then its prompt is never touched", () => {
    // given
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    const verdict = reconcile(system, CLAUDE_MODEL, { agent: "oracle" })

    // then
    expect(verdict.reason).toBe("other-agent")
    expect(system[0].text).toBe(BAKED_BODY)
  })

  test("#given an empty or unrelated system #when reconciled #then it is a no-op", () => {
    // given
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    const unrelated = [{ type: "text", text: "some other agent's prompt" }]

    // when / then
    expect(reconcile([], CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID }).reason).toBe("body-absent")
    expect(reconcile(unrelated, CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID }).reason).toBe("body-absent")
    expect(unrelated[0].text).toBe("some other agent's prompt")
  })

  test("#given a reconciled body #when the same request is reconciled again #then the second pass is a stable no-op", () => {
    // given
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]
    expect(reconcile(system, CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID }).reconciled).toBe(true)

    // when: V2 rebuilds the system from the agent config and the hook runs again
    const again = reconcile(system, CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID })

    // then
    expect(again.reason).toBe("body-absent")
    expect(system[0].text).toBe(CLAUDE_BODY)
  })

  test("#given repeated requests for one runtime model #when reconciled #then the target is resolved from cache once", () => {
    // given
    const instance = createSisyphusPromptReconciler(plan())
    const system = () => [{ type: "text", text: BAKED_BODY }]

    // when
    instance.reconcile(system(), CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID })
    instance.reconcile(system(), CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID })
    instance.reconcile(system(), CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID })

    // then: three lookups, two of them cache hits; no per-request rebuild
    expect(instance.stats.lookups).toBe(3)
    expect(instance.stats.cacheHits).toBe(2)
    expect(instance.stats.swaps).toBe(3)
  })

  test("#given a provider-qualified runtime id #when reconciled #then the bare model name is the key", () => {
    // given
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile

    // when / then: the provider does not change the baked body
    for (const qualified of ["anthropic/claude-opus-5-5", "opencode/claude-opus-5-5", "github-copilot/claude-opus-5-5"]) {
      const system = [{ type: "text", text: BAKED_BODY }]
      expect(reconcile(system, qualified, { agent: SISYPHUS_AGENT_ID }).reconciled).toBe(true)
      expect(system[0].text).toBe(CLAUDE_BODY)
    }
  })
})

describe("Sisyphus prompt plan reading and helpers", () => {
  test("#given extractModelName #when given provider-qualified, bare and empty ids #then it returns the bare name", () => {
    expect(extractModelName("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5")
    expect(extractModelName("claude-opus-5-5")).toBe("claude-opus-5-5")
    expect(extractModelName("")).toBe("")
    expect(extractModelName(undefined)).toBe("")
  })

  test("#given isSisyphusAgent #when given display ids, base id, junior and others #then only Sisyphus matches", () => {
    expect(isSisyphusAgent(SISYPHUS_AGENT_ID)).toBe(true)
    expect(isSisyphusAgent("Sisyphus")).toBe(true)
    expect(isSisyphusAgent("sisyphus")).toBe(true)
    expect(isSisyphusAgent("Sisyphus-Junior")).toBe(false)
    expect(isSisyphusAgent("oracle")).toBe(false)
  })

  test("#given a manifest without the plan #when read #then it yields undefined", () => {
    expect(readSisyphusPromptPlan({ metadata: { global: {} } })).toBeUndefined()
    expect(readSisyphusPromptPlan({})).toBeUndefined()
    expect(readSisyphusPromptPlan({ metadata: { global: { sisyphusPrompt: { bakedPrompt: "" } } } })).toBeUndefined()
  })

  test("#given a manifest plan with non-string entries #when read #then only string bodies survive", () => {
    const read = readSisyphusPromptPlan({
      metadata: { global: { sisyphusPrompt: { bakedModel: BAKED_MODEL, bakedPrompt: BAKED_BODY, promptByModel: { a: CLAUDE_BODY, b: 7, c: "" } } } },
    })
    expect(read).toEqual({ bakedModel: BAKED_MODEL, bakedPrompt: BAKED_BODY, promptByModel: { a: CLAUDE_BODY } })
  })

  test("#given a manifest plan #when the reconciler is built from it #then it reconciles end to end", () => {
    // given
    const reconcile = createSisyphusPromptReconcilerFromManifest({
      metadata: { global: { sisyphusPrompt: plan() } },
    }).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    reconcile(system, CLAUDE_MODEL, { agent: SISYPHUS_AGENT_ID })

    // then
    expect(system[0].text).toBe(CLAUDE_BODY)
  })
})

describe("context hook integration", () => {
  const baseEvent = (agent, model, system) => ({
    sessionID: "s1",
    agent,
    model,
    system,
    messages: [],
  })

  function buildHook(planOverrides) {
    return createNativeContextHook({
      getDelegationRoster: async () => [],
      isRootSession: async () => true,
      sisyphusPromptPlan: plan(planOverrides),
    })
  }

  test("#given a Sisyphus request on a different runtime model #when the context hook runs #then the runtime body replaces the baked body", async () => {
    // given
    const hook = buildHook()
    const event = baseEvent(SISYPHUS_AGENT_ID, { id: CLAUDE_MODEL, providerID: "anthropic" }, [{ type: "text", text: BAKED_BODY }])

    // when
    await hook(event)

    // then
    const text = event.system.map((p) => p.text).join("\n")
    expect(text).toContain(CLAUDE_BODY)
    expect(text).not.toContain(BAKED_BODY)
  })

  test("#given a non-Sisyphus request #when the context hook runs #then the body is untouched", async () => {
    // given
    const hook = buildHook()
    const event = baseEvent("oracle", { id: CLAUDE_MODEL, providerID: "anthropic" }, [{ type: "text", text: BAKED_BODY }])

    // when
    await hook(event)

    // then
    expect(event.system.some((p) => p.text === BAKED_BODY)).toBe(true)
  })

  test("#given a manifest without a plan #when the context hook runs #then it stays a pure no-op", async () => {
    // given
    const hook = createNativeContextHook({ getDelegationRoster: async () => [], isRootSession: async () => true })
    const event = baseEvent(SISYPHUS_AGENT_ID, { id: CLAUDE_MODEL, providerID: "anthropic" }, [{ type: "text", text: BAKED_BODY }])

    // when
    await hook(event)

    // then
    expect(event.system.some((p) => p.text === BAKED_BODY)).toBe(true)
  })
})

describe("explicit GPT prompt-identity buckets (Astra included)", () => {
  const positives = [
    ["gpt-6-astra", "gpt-6-astra"],
    ["gpt-6-astra-fast", "gpt-6-astra"],
    ["openai/gpt-6-astra", "gpt-6-astra"],
    ["chatgpt-subscription/gpt-6-astra-fast", "gpt-6-astra"],
    ["github-copilot/gpt-6-astra", "gpt-6-astra"],
    [" GPT-6-Astra ", "gpt-6-astra"],
    ["gpt-6-astra:high", "gpt-6-astra"],
    ["gpt-6-astra:off", "gpt-6-astra"],
    ["gpt-6-astra-fast:max", "gpt-6-astra"],
    ["chatgpt-subscription/gpt-6-astra (high)", "gpt-6-astra"],
    ["openai/gpt-6-astra-fast xhigh", "gpt-6-astra"],
    ["vercel/openai/gpt-6-astra: auto", "gpt-6-astra"],
    ["gpt-6-sol", "gpt-6-sol"],
    ["openai/gpt-6-sol-fast:high", "gpt-6-sol"],
    ["openai/gpt-5.5", "gpt-5.5"],
    ["openai/gpt-5.6-sol", "gpt-5.6-sol"],
  ]

  test("#given explicit selectors #when resolved #then each maps to its identity bucket", () => {
    for (const [model, bucket] of positives) {
      expect(resolveGptPromptIdentityBucket(model), model).toBe(bucket)
    }
  })

  const negatives = [
    undefined, "", "unknown", "openai/gpt-6.1-sol", "gpt-6-luna", "gpt-6-luna-fast",
    "anthropic/claude-fable-5", "gpt-6-astra/claude-opus-5-5", "custom-gpt-6-astra",
    "gpt-6-astra-preview", "gpt-6-astra-fastest", "gpt-6-astra:unrecognized",
    "gpt-6-astra:none", "gpt-6-astra (unrecognized)", "gpt-6-astra unrelated",
  ]

  test("#given other or accidental selectors #when resolved #then no bucket is returned", () => {
    for (const model of negatives) {
      expect(resolveGptPromptIdentityBucket(model), String(model)).toBeUndefined()
    }
  })

  test("#given an Astra runtime selector #when reconciled #then the Astra body is selected", () => {
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    for (const model of ["openai/gpt-6-astra", "github-copilot/gpt-6-astra-fast", "openai/gpt-6-astra:off"]) {
      const system = [{ type: "text", text: BAKED_BODY }]
      expect(reconcile(system, model, { agent: SISYPHUS_AGENT_ID }).reconciled, model).toBe(true)
      expect(system[0].text).toBe(ASTRA_BODY)
    }
  })

  test("#given a bogus Astra variant #when reconciled #then nothing changes and the miss is reported", () => {
    // given
    const events = []
    const reconcile = createSisyphusPromptReconciler(plan({ onReconcile: (e) => events.push(e) })).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    const verdict = reconcile(system, "openai/gpt-6-astra:none", { agent: SISYPHUS_AGENT_ID })

    // then
    expect(verdict.reason).toBe("model-not-baked")
    expect(system[0].text).toBe(BAKED_BODY)
    expect(events[0]?.reason).toBe("model-not-baked")
  })

  test("#given an accidental Astra selector #when reconciled #then no swap happens and the miss is reported", () => {
    // given
    const events = []
    const reconcile = createSisyphusPromptReconciler(plan({ onReconcile: (e) => events.push(e) })).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    const verdict = reconcile(system, "openai/custom-gpt-6-astra", { agent: SISYPHUS_AGENT_ID })

    // then
    expect(verdict.reason).toBe("model-not-baked")
    expect(system[0].text).toBe(BAKED_BODY)
    expect(events[0]?.reason).toBe("model-not-baked")
  })

  test("#given a non-gpt model #when reconciled #then the exact-model path is unaffected by the gpt resolver", () => {
    // given: kimi is a baked exact model, not a gpt identity
    const reconcile = createSisyphusPromptReconciler(plan()).reconcile
    const system = [{ type: "text", text: BAKED_BODY }]

    // when
    reconcile(system, KIMI_MODEL, { agent: SISYPHUS_AGENT_ID })

    // then
    expect(system[0].text).toBe(KIMI_BODY)
  })
})

describe("prompt-identity parity with the V1 owner", () => {
  test("#given the baked identity set #when the V1 owner is asked #then each representative names its own identity", () => {
    for (const model of SISYPHUS_PROMPT_IDENTITY_MODELS) {
      expect(getGptPromptIdentityKey(`openai/${model}`), model).toBe(model)
      expect(resolveGptPromptIdentityBucket(`openai/${model}`), model).toBe(model)
    }
    // gpt-family has no representative and is intentionally absent from the set.
    expect(getGptPromptIdentityKey("openai/gpt-4o")).toBe("gpt-family")
    expect(SISYPHUS_PROMPT_IDENTITY_MODELS).not.toContain("gpt-family")
  })
})

describe("plain-line format-example fix (upstream 65f159da3)", () => {
  const QUOTED_VERBALIZE = '> "I detect [research / implementation / investigation / evaluation / fix / open-ended] intent - [reason]. My approach: [plan]."'
  const QUOTED_HANDOFF = "> [Outcome so far] toward [the user's original ask and the result they wanted]. You need: [ledger N/M done, findings, blockers]. Now: [todo task in progress]. Next: [next open task]."

  test("#given the quoted format examples #when fixed #then no quote line with a placeholder remains", () => {
    const body = `head\n${QUOTED_VERBALIZE}\nmid\n${QUOTED_HANDOFF}\ntail`
    const fixed = applySisyphusFormatExampleFix(body)
    expect(fixed.split("\n").filter((line) => /^\s*>.*\[[^\]]+\]/.test(line))).toEqual([])
    expect(fixed).toContain('"I detect [research')
    expect(fixed).toContain("[Outcome so far] toward")
  })

  test("#given an already-plain body #when fixed #then it is byte-identical (idempotent)", () => {
    const body = 'head\n"I detect [research / implementation / investigation / evaluation / fix / open-ended] intent - [reason]. My approach: [plan]."\ntail'
    const once = applySisyphusFormatExampleFix(body)
    expect(applySisyphusFormatExampleFix(once)).toBe(once)
  })

  test("#given unrelated quote lines #when fixed #then they are untouched (not a generic normalizer)", () => {
    const body = "> a plain quote note\n> [a link] stays\nnormal"
    expect(applySisyphusFormatExampleFix(body)).toBe(body)
  })

  test("#given an agents map #when fixed #then only the Sisyphus entry changes", () => {
    const oracle = { prompt: `oracle body\n${QUOTED_HANDOFF}` }
    const agents = { [SISYPHUS_AGENT_ID]: { prompt: `sisyphus body\n${QUOTED_VERBALIZE}` }, oracle }
    const fixed = fixSisyphusAgentMap(agents)
    expect(fixed[SISYPHUS_AGENT_ID].prompt).not.toContain('> "I detect')
    expect(fixed.oracle).toBe(oracle)
    expect(fixed.oracle.prompt).toBe(oracle.prompt)
  })

  test("#given the fix provenance #then it names the upstream commit", () => {
    expect(SISYPHUS_FORMAT_EXAMPLE_PROVENANCE).toBe("upstream 65f159da3")
  })
})

describe("bake-time dispose containment (no empty catch)", () => {
  test("#given a dispose that throws synchronously #when contained #then it is reported and not rethrown", async () => {
    const messages = []
    await disposeBakeHooks({ dispose: () => { throw new Error("sync boom") } }, "variant", (message) => messages.push(message))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("sync boom")
  })

  test("#given a dispose that rejects #when contained #then it is reported and not rethrown", async () => {
    const messages = []
    await disposeBakeHooks({ dispose: async () => { throw new Error("async boom") } }, "variant", (message) => messages.push(message))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("async boom")
  })

  test("#given a successful dispose #when contained #then nothing is reported", async () => {
    const messages = []
    await disposeBakeHooks({ dispose: async () => undefined }, "variant", (message) => messages.push(message))
    expect(messages).toHaveLength(0)
  })

  test("#given no dispose hook #when contained #then it is a no-op", async () => {
    const messages = []
    await disposeBakeHooks({}, "variant", (message) => messages.push(message))
    await disposeBakeHooks(undefined, "variant", (message) => messages.push(message))
    expect(messages).toHaveLength(0)
  })
})
