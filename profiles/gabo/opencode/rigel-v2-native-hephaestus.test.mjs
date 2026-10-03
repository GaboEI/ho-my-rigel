import { describe, expect, test } from "bun:test"
import { isHephaestusSupportedModel as tsIsHephaestusSupportedModel } from "../../../packages/omo-opencode/src/agents/hephaestus/agent.ts"
import { AGENT_MODEL_REQUIREMENTS } from "../../../packages/model-core/src/agent-model-requirements.ts"
import {
  HEPHAESTUS_REQUIRED_PROVIDERS,
  evaluateHephaestusGate,
  isHephaestusAgentId,
  isHephaestusSupportedModel,
} from "./rigel-v2-native-hephaestus.mjs"

// Read once at module scope: the fixture compatibility contract below parses
// the real contract source, so a fixture that the gate would block fails here.
const agentsMdContractSource = (await import("node:fs"))
  .readFileSync(new URL("../../../profiles/gabo/qa-v2-agents-md-contract.mjs", import.meta.url), "utf8")

// The native V2 runtime cannot import `packages/` TypeScript, so the gate is a
// plain-data port of two real owners:
//   packages/omo-opencode/src/agents/hephaestus/agent.ts (model support)
//   packages/omo-opencode/src/agents/builtin-agents/hephaestus-agent.ts (provider + model gating)
// These tests import the real TS and pin agreement, so an upstream gate edit
// that is not mirrored here fails the suite.
describe("hephaestus model support parity", () => {
  const corpus = [
    undefined,
    "",
    "gpt-6-sol",
    "openai/gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.3-codex",
    "gpt-6-luna",
    "openai/gpt-6-luna",
    "amazon-bedrock/us.openai.gpt-5.4",
    "GPT-5.4",
    "gpt-6",
    "claude-opus-5-5",
    "anthropic/claude-fable-5-1",
    "glm-5.2",
    "kimi-k3",
    "qwen3.7-plus",
    "gemini-3.1-pro",
    "deepseek-flash",
    "minimax-m3",
    "gpt-4o",
    "gpt-5.2",
    "grok-4.7",
    "gpt-5.3",
    "gpt-5.7",
  ]

  const expected = new Map([
    [undefined, false],
    ["", false],
    ["gpt-6-sol", true],
    ["openai/gpt-6-sol", true],
    ["gpt-5.6-sol", true],
    ["gpt-5.4", true],
    ["gpt-5.5", true],
    ["gpt-5.3-codex", true],
    ["gpt-6-luna", true],
    ["openai/gpt-6-luna", true],
    ["amazon-bedrock/us.openai.gpt-5.4", true],
    ["GPT-5.4", true],
    ["gpt-6", true],
    ["claude-opus-5-5", false],
    ["anthropic/claude-fable-5-1", false],
    ["glm-5.2", false],
    ["kimi-k3", false],
    ["qwen3.7-plus", false],
    ["gemini-3.1-pro", false],
    ["deepseek-flash", false],
    ["minimax-m3", false],
    ["gpt-4o", false],
    ["gpt-5.2", false],
    ["grok-4.7", false],
    ["gpt-5.3", false],
    ["gpt-5.7", false],
  ])

  test("isHephaestusSupportedModel agrees with the TS owner for every corpus entry", () => {
    // given the real TS model-support predicate and the V2 port
    for (const entry of corpus) {
      // when each corpus model id is classified
      const ported = isHephaestusSupportedModel(entry)
      const upstream = tsIsHephaestusSupportedModel(entry)
      // then the port matches the owner, and the owner matches the frozen expectation
      expect({ entry, ported }).toEqual({ entry, ported: upstream })
      expect({ entry, ported }).toEqual({ entry, ported: expected.get(entry) })
    }
  })

  test("HEPHAESTUS_REQUIRED_PROVIDERS agrees with the model-core requirement", () => {
    // given the model-core requirement for hephaestus
    const required = AGENT_MODEL_REQUIREMENTS.hephaestus.requiresProvider
    // when the V2 port is compared to it
    // then the arrays are deeply equal
    expect(HEPHAESTUS_REQUIRED_PROVIDERS).toEqual(required)
  })
})

describe("isHephaestusAgentId", () => {
  test("matches the canonical id with or without a V2 display suffix", () => {
    // given V2 display names and the bare canonical id
    const inputs = ["Hephaestus - Deep Agent", "hephaestus", " Hephaestus - Deep Agent "]
    // when each is normalized
    // then all are recognized
    for (const input of inputs) {
      expect(isHephaestusAgentId(input)).toBe(true)
    }
  })

  test("rejects other agents and empty ids", () => {
    // given non-hephaestus or empty inputs
    const inputs = ["Sisyphus - ultraworker", "atlas", "", undefined]
    // when each is normalized
    // then none are recognized
    for (const input of inputs) {
      expect(isHephaestusAgentId(input)).toBe(false)
    }
  })
})

describe("evaluateHephaestusGate", () => {
  const requiredProviderMessage = "[ho-my-rigel] [agent-registration] Agent skipped: required provider not connected (agent=hephaestus; requiredProvider=openai|chatgpt-subscription|github-copilot|opencode)"
  const unsupportedModelMessage = (id) => `[ho-my-rigel] [agent-registration] Agent skipped: unsupported Hephaestus model (agent=hephaestus; model=${id ?? "undefined"})`

  test("registers when a required provider is connected and the model is GPT", () => {
    // given an openai inventory row and a GPT model ref
    const definition = {}
    const model = { providerID: "openai", id: "gpt-6-luna" }
    const inventory = [{ providerID: "openai", id: "gpt-6-luna" }]
    // when the gate is evaluated
    const verdict = evaluateHephaestusGate({ definition, model, inventory })
    // then the agent registers with the model echoed
    expect(verdict).toEqual({ eligible: true, model: { providerID: "openai", id: "gpt-6-luna" } })
  })

  test("blocks when no connected provider is required", () => {
    // given an inventory whose only provider is not required
    const model = { providerID: "opencode-go", id: "gpt-6-luna" }
    const inventory = [{ providerID: "opencode-go", id: "gpt-6-luna" }]
    // when the gate is evaluated
    const verdict = evaluateHephaestusGate({ definition: {}, model, inventory })
    // then the provider gate blocks with the exact message
    expect(verdict).toEqual({ eligible: false, reason: "provider", message: requiredProviderMessage })
    expect(verdict.message).toContain("required provider not connected")
  })

  test("blocks a non-GPT model even when a required provider is connected", () => {
    // given a required provider but a non-GPT model
    const model = { providerID: "openai", id: "kimi-k3" }
    const inventory = [{ providerID: "openai", id: "kimi-k3" }]
    // when the gate is evaluated
    const verdict = evaluateHephaestusGate({ definition: {}, model, inventory })
    // then the model gate blocks with the exact message
    expect(verdict).toEqual({ eligible: false, reason: "model", message: unsupportedModelMessage("kimi-k3") })
    expect(verdict.message).toContain("unsupported Hephaestus model")
  })

  test("skips the provider check entirely when there is no inventory (first run)", () => {
    // given no inventory at all and a GPT model
    const model = { providerID: "openai", id: "gpt-6-sol" }
    // when the gate is evaluated
    const verdict = evaluateHephaestusGate({ definition: {}, model, inventory: undefined })
    // then the provider gate is skipped and the agent registers
    expect(verdict).toEqual({ eligible: true, model: { providerID: "openai", id: "gpt-6-sol" } })
  })

  test("still applies the model gate when there is no inventory", () => {
    // given no inventory and a non-GPT model
    const model = { providerID: "openai", id: "kimi-k3" }
    // when the gate is evaluated
    const verdict = evaluateHephaestusGate({ definition: {}, model, inventory: undefined })
    // then only the model gate blocks
    expect(verdict).toEqual({ eligible: false, reason: "model", message: unsupportedModelMessage("kimi-k3") })
  })

  test("blocks when no model can be derived at all", () => {
    // given a definition without a model and no resolved ref
    const verdict = evaluateHephaestusGate({ definition: {}, model: undefined, inventory: undefined })
    // when the gate is evaluated, then the model gate reports an undefined model
    expect(verdict).toEqual({ eligible: false, reason: "model", message: unsupportedModelMessage(undefined) })
  })

  test("derives the model from the definition string when no resolved ref is given", () => {
    // given a definition model as `provider/model` and no resolved ref
    const definition = { model: "openai/gpt-6-sol" }
    // when the gate is evaluated without an inventory
    const verdict = evaluateHephaestusGate({ definition, model: undefined, inventory: undefined })
    // then the derived GPT model registers
    expect(verdict).toEqual({ eligible: true, model: { providerID: "openai", id: "gpt-6-sol" } })
  })

  test("treats an empty inventory array as absent (V2 semantic)", () => {
    // given an empty inventory array and a GPT model
    const model = { providerID: "openai", id: "gpt-6-sol" }
    // when the gate is evaluated
    const verdict = evaluateHephaestusGate({ definition: {}, model, inventory: [] })
    // then the provider check is skipped exactly like undefined
    // (V2 has no first-run state flag, so an empty list cannot mean "known and none connected")
    expect(verdict).toEqual({ eligible: true, model: { providerID: "openai", id: "gpt-6-sol" } })
  })
})

// Cross-artifact contract: the Hephaestus fixture inside
// `qa-v2-agents-md-contract.mjs` must satisfy the real registration gate,
// because that contract creates a Hephaestus session and would break if the
// gate dropped the agent. This test reads the fixture as written and fails for
// the intended reason if it reverts to a provider/model the gate blocks
// (the original `rigel-fixture/fixture` did exactly that).
describe("qa-v2-agents-md-contract Hephaestus fixture compatibility", () => {
  const contractSource = agentsMdContractSource

  function fixtureHephaestusModel() {
    const match = /"Hephaestus - Deep Agent":\s*\{[^}]*?model:\s*"([^"]+)"/.exec(contractSource)
    if (!match) throw new Error("qa-v2-agents-md-contract.mjs no longer declares a Hephaestus fixture model")
    return match[1]
  }

  function fixtureProviderDeclares(providerID, modelID) {
    const pattern = new RegExp(`${providerID}:\\s*\\{[\\s\\S]*?models:\\s*\\{\\s*["']?${modelID}["']?\\s*:\\s*\\{`)
    return pattern.test(contractSource)
  }

  test("the fixture Hephaestus model is eligible under the real gate", () => {
    // given the fixture model declared by the contract
    const raw = fixtureHephaestusModel()
    const [providerID, modelID] = raw.split("/")
    // and the contract config actually declares that provider/model for the mock
    const declared = fixtureProviderDeclares(providerID, modelID)
    // when the gate evaluates the fixture against that declared inventory
    const verdict = evaluateHephaestusGate({
      definition: { model: raw },
      inventory: [{ providerID, id: modelID }],
    })
    // then the contract's Hephaestus session can be created: the gate admits it
    expect(declared).toBe(true)
    expect(verdict).toEqual({ eligible: true, model: { providerID, id: modelID } })
  })
})
