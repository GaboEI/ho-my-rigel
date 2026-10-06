import { expect, test } from "bun:test"
import {
  buildReasoningOptions,
  detectThinkKeyword,
  isAlreadyHighVariant,
  normalizeReasoningLevel,
  reasoningEffortFromThinking,
  stripCodeText,
  thinkingBudgetForLevel,
} from "./rigel-v2-native-reasoning-options.mjs"

test("detectThinkKeyword matches English and multilingual words but ignores code", () => {
  expect(detectThinkKeyword("please think about this")).toBe(true)
  expect(detectThinkKeyword("ultrathink now")).toBe(true)
  expect(detectThinkKeyword("생각해줘")).toBe(true)
  expect(detectThinkKeyword("подумай внимательно")).toBe(true)
  expect(detectThinkKeyword("привет мир")).toBe(false)
  expect(detectThinkKeyword("думать над задачей")).toBe(true)
  expect(detectThinkKeyword("a thinker and a rethink")).toBe(false)
  expect(detectThinkKeyword("```\nthink\n```")).toBe(false)
  expect(detectThinkKeyword("use `think` here")).toBe(false)
  expect(detectThinkKeyword("no trigger word")).toBe(false)
})

test("stripCodeText removes fenced and inline code", () => {
  expect(stripCodeText("a ```x``` b `y` c")).toBe("a   b   c")
})

test("isAlreadyHighVariant detects the -high suffix with or without a provider prefix", () => {
  expect(isAlreadyHighVariant("gpt-5-1-codex-high")).toBe(true)
  expect(isAlreadyHighVariant("aws/anthropic/claude-opus-4-7-high")).toBe(true)
  expect(isAlreadyHighVariant("gpt-5-1-codex")).toBe(false)
  expect(isAlreadyHighVariant("opencode-go/deepseek-v4.1-flash")).toBe(false)
})

test("normalizeReasoningLevel maps none to off and rejects arbitrary names", () => {
  expect(normalizeReasoningLevel("none")).toBe("off")
  expect(normalizeReasoningLevel("HIGH")).toBe("high")
  expect(normalizeReasoningLevel("max")).toBe("max")
  expect(normalizeReasoningLevel("bogus")).toBeUndefined()
})

test("reasoningEffortFromThinking maps budget bands and ignores disabled thinking", () => {
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 32000 })).toBe("high")
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 16000 })).toBe("medium")
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 8000 })).toBe("low")
  expect(reasoningEffortFromThinking({ type: "enabled" })).toBe("high")
  expect(reasoningEffortFromThinking({ type: "disabled" })).toBeUndefined()
  expect(reasoningEffortFromThinking(undefined)).toBeUndefined()
})

test("buildReasoningOptions carries agent tuning as camelCase V2 semantic options", () => {
  const { options, source } = buildReasoningOptions({
    tuning: { temperature: 0.1, top_p: 0.8, maxTokens: 64000, textVerbosity: "low" },
    currentTurnText: "plain turn",
    modelID: "opencode-go/deepseek-v4.1-flash",
  })
  expect(options).toEqual({ temperature: 0.1, topP: 0.8, maxTokens: 64000, textVerbosity: "low" })
  expect(source).toBeNull()
})

test("explicit agent reasoning wins over the think keyword and carries its thinking budget", () => {
  const { options, source } = buildReasoningOptions({
    tuning: { reasoning: "low", thinking: { type: "enabled", budgetTokens: 32000 } },
    currentTurnText: "please think hard",
    modelID: "gpt-5",
  })
  expect(options).toEqual({ reasoningEffort: "low", thinking: { type: "enabled", budgetTokens: 32000 } })
  expect(source).toBe("agent")
})

test("an enabled thinking budget becomes a reasoning level plus the Anthropic thinking carrier", () => {
  const { options, source } = buildReasoningOptions({
    tuning: { thinking: { type: "enabled", budgetTokens: 32000 } },
    currentTurnText: "plain",
    modelID: "gpt-5",
  })
  expect(options).toEqual({ reasoningEffort: "high", thinking: { type: "enabled", budgetTokens: 32000 } })
  expect(source).toBe("agent")
})

test("think keyword raises the reasoning level and the Anthropic thinking budget for the current turn", () => {
  const { options, source } = buildReasoningOptions({ currentTurnText: "please think", modelID: "gpt-5" })
  expect(options).toEqual({ reasoningEffort: "high", thinking: { type: "enabled", budgetTokens: 32000 } })
  expect(source).toBe("think")
})

test("thinkingBudgetForLevel maps levels to Anthropic thinking budgets and omits off", () => {
  expect(thinkingBudgetForLevel("high")).toBe(32000)
  expect(thinkingBudgetForLevel("medium")).toBe(16000)
  expect(thinkingBudgetForLevel("off")).toBeUndefined()
})

test("think keyword is suppressed for already-high models, disabled think-mode, and code blocks", () => {
  expect(buildReasoningOptions({ currentTurnText: "think", modelID: "gpt-5-high" }).options).toEqual({})
  expect(buildReasoningOptions({ currentTurnText: "think", modelID: "gpt-5", thinkModeEnabled: false }).options).toEqual({})
  expect(buildReasoningOptions({ currentTurnText: "```think```", modelID: "gpt-5" }).options).toEqual({})
})

test("reasoning options never carry a model variant key, so agent/category variant routing is untouched", () => {
  const { options } = buildReasoningOptions({ tuning: { reasoning: "high" }, currentTurnText: "please think", modelID: "gpt-5" })
  expect(Object.prototype.hasOwnProperty.call(options, "variant")).toBe(false)
})


