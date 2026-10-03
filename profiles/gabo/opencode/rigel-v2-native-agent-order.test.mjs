import { describe, expect, test } from "bun:test"
import { DEFAULT_AGENT_ORDER } from "../../../packages/omo-opencode/src/shared/agent-ordering.ts"
import { getAgentListDisplayName } from "../../../packages/omo-opencode/src/shared/agent-display-names.ts"
import {
  CANONICAL_AGENT_KEYS,
  canonicalAgentKey,
  sortAgentsByCanonicalOrder,
} from "./rigel-v2-native-agent-order.mjs"

// The native V2 runtime cannot import `packages/` TypeScript, so the canonical
// order is a plain-data port of the real owner:
//   packages/omo-opencode/src/shared/agent-ordering.ts (DEFAULT_AGENT_ORDER)
//   packages/omo-opencode/src/shared/agent-display-names.ts (display -> key)
// These tests import the real TS and pin agreement, so an upstream order or
// display-name edit that is not mirrored here fails the suite.
describe("canonical agent order parity", () => {
  test("mirrors the upstream DEFAULT_AGENT_ORDER", () => {
    expect(CANONICAL_AGENT_KEYS).toEqual([...DEFAULT_AGENT_ORDER])
  })

  test("maps every upstream display name back to its config key", () => {
    for (const key of DEFAULT_AGENT_ORDER) {
      expect(canonicalAgentKey(getAgentListDisplayName(key))).toBe(key)
    }
  })

  test("normalizes display names, ids, and unknown names to config keys", () => {
    expect(canonicalAgentKey("Sisyphus - ultraworker")).toBe("sisyphus")
    expect(canonicalAgentKey("Hephaestus - Deep Agent")).toBe("hephaestus")
    expect(canonicalAgentKey("Prometheus - Plan Builder")).toBe("prometheus")
    expect(canonicalAgentKey("Atlas - Plan Executor")).toBe("atlas")
    expect(canonicalAgentKey("explore")).toBe("explore")
    expect(canonicalAgentKey("  EXPLORE  ")).toBe("explore")
    expect(canonicalAgentKey("Sisyphus-Junior")).toBe("sisyphus-junior")
  })
})

describe("sortAgentsByCanonicalOrder", () => {
  test("partitions core agents to the canonical head and preserves remainder order", () => {
    const input = [
      { id: "judge", name: "Judge", mode: "all" },
      { id: "atlas", name: "Atlas - Plan Executor", mode: "all" },
      { id: "explore", name: "Explore", mode: "subagent" },
      { id: "prometheus", name: "Prometheus - Plan Builder", mode: "all" },
      { id: "oracle", name: "oracle", mode: "subagent" },
      { id: "hephaestus", name: "Hephaestus - Deep Agent", mode: "all" },
      { id: "sisyphus", name: "Sisyphus - ultraworker", mode: "all" },
    ]
    const sorted = sortAgentsByCanonicalOrder(input)
    expect(sorted.map((agent) => agent.id)).toEqual([
      "sisyphus",
      "hephaestus",
      "prometheus",
      "atlas",
      "judge",
      "explore",
      "oracle",
    ])
  })

  test("returns a new array and never mutates the input", () => {
    const input = [{ id: "explore", name: "explore" }, { id: "sisyphus", name: "Sisyphus - ultraworker" }]
    const snapshot = [...input]
    const sorted = sortAgentsByCanonicalOrder(input)
    expect(sorted).not.toBe(input)
    expect(input).toEqual(snapshot)
    expect(sorted.map((agent) => agent.id)).toEqual(["sisyphus", "explore"])
  })

  test("is empty- and undefined-safe and keeps unnamed entries in the remainder", () => {
    expect(sortAgentsByCanonicalOrder(undefined)).toEqual([])
    expect(sortAgentsByCanonicalOrder([])).toEqual([])
    const sorted = sortAgentsByCanonicalOrder([
      { mode: "all" },
      "raw",
      null,
      { id: "sisyphus", name: "Sisyphus - ultraworker" },
    ])
    expect(sorted[0]).toEqual({ id: "sisyphus", name: "Sisyphus - ultraworker" })
    expect(sorted.slice(1)).toEqual([{ mode: "all" }, "raw", null])
  })

  test("yields the same canonical core prefix for two input orders", () => {
    const base = ["sisyphus", "hephaestus", "prometheus", "atlas", "judge", "explore"]
    const first = base.map((id) => ({ id, name: id }))
    const second = [...base].reverse().map((id) => ({ id, name: id }))
    const corePrefix = (list) => sortAgentsByCanonicalOrder(list).slice(0, 4).map((agent) => agent.id)
    expect(corePrefix(first)).toEqual(["sisyphus", "hephaestus", "prometheus", "atlas"])
    expect(corePrefix(second)).toEqual(corePrefix(first))
  })
})
