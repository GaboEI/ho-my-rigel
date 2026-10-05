import { describe, expect, test } from "bun:test"
import { ConcurrencyManager } from "../../../packages/omo-opencode/src/features/background-agent/concurrency.ts"
import {
  normalizeModel,
  providerOf,
  resolveAdmissionKey,
  resolveAdmissionLimit,
} from "./rigel-v2-background-key.mjs"

// The native V2 runtime cannot import `packages/` TypeScript, so the admission
// key derivation is a plain-JS port of the real owner:
//   packages/omo-opencode/src/features/background-agent/concurrency.ts
//     getConcurrencyLimit (25-40) and getConcurrencyKey (42-53)
// These tests import the real TS and pin agreement, so an upstream priority or
// key-shape edit that is not mirrored here fails the suite.

describe("resolveAdmissionLimit parity with V1 ConcurrencyManager", () => {
  test("returns the model limit when modelConcurrency matches", () => {
    // given
    const config = { modelConcurrency: { "anthropic/claude-sonnet-4-6": 5 } }

    // when
    const limit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", config)

    // then
    expect(limit).toBe(5)
  })

  test("returns the provider limit when only providerConcurrency matches", () => {
    // given
    const config = { providerConcurrency: { anthropic: 3 } }

    // when
    const limit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", config)

    // then
    expect(limit).toBe(3)
  })

  test("returns the default limit when neither model nor provider matches", () => {
    // given
    const config = { defaultConcurrency: 2 }

    // when
    const limit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", config)

    // then
    expect(limit).toBe(2)
  })

  test("returns 5 when no config is provided", () => {
    // given
    const config = undefined

    // when
    const limit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", config)

    // then
    expect(limit).toBe(5)
  })

  test("returns 5 when config exists but declares no concurrency settings", () => {
    // given
    const config = {}

    // when
    const limit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", config)

    // then
    expect(limit).toBe(5)
  })

  test("prioritizes model over provider over default", () => {
    // given
    const config = {
      modelConcurrency: { "anthropic/claude-sonnet-4-6": 10 },
      providerConcurrency: { anthropic: 5 },
      defaultConcurrency: 2,
    }

    // when
    const modelLimit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", config)
    const providerLimit = resolveAdmissionLimit("anthropic/claude-opus-4-7", config)
    const defaultLimit = resolveAdmissionLimit("google/gemini-3.1-pro", config)

    // then
    expect(modelLimit).toBe(10)
    expect(providerLimit).toBe(5)
    expect(defaultLimit).toBe(2)
  })

  test("treats a 0 limit as Infinity at every tier", () => {
    // given
    const modelZero = { modelConcurrency: { "anthropic/claude-sonnet-4-6": 0 } }
    const providerZero = { providerConcurrency: { anthropic: 0 } }
    const defaultZero = { defaultConcurrency: 0 }

    // when
    const modelLimit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", modelZero)
    const providerLimit = resolveAdmissionLimit("anthropic/claude-sonnet-4-6", providerZero)
    const defaultLimit = resolveAdmissionLimit("any-model", defaultZero)

    // then
    expect(modelLimit).toBe(Infinity)
    expect(providerLimit).toBe(Infinity)
    expect(defaultLimit).toBe(Infinity)
  })

  test("treats a model with no provider segment as its own provider", () => {
    // given
    const config = { providerConcurrency: { "custom-model": 4 } }

    // when
    const limit = resolveAdmissionLimit("custom-model", config)

    // then
    expect(limit).toBe(4)
  })

  test("agrees with the real V1 ConcurrencyManager across a config matrix", () => {
    // given
    const configs = [
      undefined,
      {},
      { modelConcurrency: { "anthropic/claude-sonnet-4-6": 5 } },
      { providerConcurrency: { anthropic: 3 } },
      { defaultConcurrency: 2 },
      { modelConcurrency: { "anthropic/claude-sonnet-4-6": 10 }, providerConcurrency: { anthropic: 5 }, defaultConcurrency: 2 },
      { modelConcurrency: { "anthropic/claude-sonnet-4-6": 0 } },
      { providerConcurrency: { anthropic: 0 } },
      { defaultConcurrency: 0 },
      { modelConcurrency: { "google/gemini-3.1-pro": 5 }, providerConcurrency: { anthropic: 3 } },
    ]
    const models = [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-7",
      "google/gemini-3.1-pro",
      "custom-model",
    ]

    // when / then
    for (const config of configs) {
      const manager = new ConcurrencyManager(config)
      for (const model of models) {
        expect(resolveAdmissionLimit(model, config)).toBe(manager.getConcurrencyLimit(model))
      }
    }
  })
})

describe("resolveAdmissionKey parity with V1 ConcurrencyManager", () => {
  test("keeps the exact model key when modelConcurrency is configured", () => {
    // given
    const config = {
      modelConcurrency: { "anthropic/claude-sonnet-4-6": 1 },
      providerConcurrency: { anthropic: 1 },
    }

    // when
    const key = resolveAdmissionKey("anthropic/claude-sonnet-4-6", config)

    // then
    expect(key).toBe("anthropic/claude-sonnet-4-6")
  })

  test("collapses to the provider key when only providerConcurrency is configured", () => {
    // given
    const config = { providerConcurrency: { anthropic: 1 } }

    // when
    const firstKey = resolveAdmissionKey("anthropic/claude-sonnet-4-6", config)
    const secondKey = resolveAdmissionKey("anthropic/claude-opus-4-7", config)

    // then
    expect(firstKey).toBe("anthropic")
    expect(secondKey).toBe("anthropic")
  })

  test("keeps the exact model key when only defaultConcurrency is configured", () => {
    // given
    const config = { defaultConcurrency: 1 }

    // when
    const key = resolveAdmissionKey("anthropic/claude-sonnet-4-6", config)

    // then
    expect(key).toBe("anthropic/claude-sonnet-4-6")
  })

  test("keeps the exact model key when no config is provided", () => {
    // given
    const config = undefined

    // when
    const key = resolveAdmissionKey("anthropic/claude-sonnet-4-6", config)

    // then
    expect(key).toBe("anthropic/claude-sonnet-4-6")
  })

  test("agrees with the real V1 ConcurrencyManager across a config matrix", () => {
    // given
    const configs = [
      undefined,
      {},
      { modelConcurrency: { "anthropic/claude-sonnet-4-6": 1 } },
      { providerConcurrency: { anthropic: 1 } },
      { defaultConcurrency: 1 },
      { modelConcurrency: { "anthropic/claude-sonnet-4-6": 1 }, providerConcurrency: { anthropic: 1 } },
      { modelConcurrency: { "google/gemini-3.1-pro": 5 }, providerConcurrency: { anthropic: 3 } },
    ]
    const models = [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-7",
      "google/gemini-3.1-pro",
      "custom-model",
    ]

    // when / then
    for (const config of configs) {
      const manager = new ConcurrencyManager(config)
      for (const model of models) {
        expect(resolveAdmissionKey(model, config)).toBe(manager.getConcurrencyKey(model))
      }
    }
  })
})

describe("resolveAdmissionKey route stability", () => {
  test("derives the same key for the category route and the subagent_type route", () => {
    // given: the category route supplies `category?.model` pre-spawn
    // (rigel-v2-native.mjs:618); the subagent_type route resolves the model
    // only after session creation via onChildSession (native.mjs:620-624).
    // Both routes hand the SAME resolved model string to this derivation.
    const config = { providerConcurrency: { anthropic: 2 } }
    const categoryRouteModel = "anthropic/claude-sonnet-4-6"
    const subagentRouteModel = "anthropic/claude-sonnet-4-6"

    // when
    const categoryKey = resolveAdmissionKey(categoryRouteModel, config)
    const subagentKey = resolveAdmissionKey(subagentRouteModel, config)

    // then
    expect(categoryKey).toBe(subagentKey)
    expect(categoryKey).toBe("anthropic")
  })

  test("is stable across repeated calls with the same inputs", () => {
    // given
    const config = { modelConcurrency: { "anthropic/claude-sonnet-4-6": 3 } }
    const model = "anthropic/claude-sonnet-4-6"

    // when
    const first = resolveAdmissionKey(model, config)
    const second = resolveAdmissionKey(model, config)
    const third = resolveAdmissionKey(model, config)

    // then
    expect(first).toBe(second)
    expect(second).toBe(third)
  })

  test("does not mutate the config it reads", () => {
    // given
    const config = { providerConcurrency: { anthropic: 2 } }
    const snapshot = JSON.parse(JSON.stringify(config))

    // when
    resolveAdmissionKey("anthropic/claude-sonnet-4-6", config)
    resolveAdmissionLimit("anthropic/claude-sonnet-4-6", config)

    // then
    expect(config).toEqual(snapshot)
  })
})

describe("providerOf and normalizeModel", () => {
  test("splits the provider before the first slash", () => {
    // given / when / then
    expect(providerOf("anthropic/claude-sonnet-4-6")).toBe("anthropic")
    expect(providerOf("openrouter/anthropic/claude-sonnet-4-6")).toBe("openrouter")
    expect(providerOf("custom-model")).toBe("custom-model")
    expect(providerOf("")).toBe("")
  })

  test("normalizes non-string input to an empty string", () => {
    // given / when / then
    expect(normalizeModel(undefined)).toBe("")
    expect(normalizeModel(null)).toBe("")
    expect(normalizeModel(42)).toBe("")
    expect(normalizeModel("anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6")
  })

  test("never throws on a missing model and falls back to the default limit", () => {
    // given
    const config = { defaultConcurrency: 2 }

    // when
    const key = resolveAdmissionKey(undefined, config)
    const limit = resolveAdmissionLimit(undefined, config)

    // then
    expect(key).toBe("")
    expect(limit).toBe(2)
  })
})
