import { describe, expect, test } from "bun:test"
import { trimToolNamesToCap } from "./rigel-v2-native-tool-trimming.mjs"

describe("native max_tools trimming", () => {
  test("keeps everything when the cap is unset or not exceeded", () => {
    const names = ["session_list", "look_at", "rigel_task"]
    expect(trimToolNamesToCap(names, undefined)).toEqual({ kept: names, removed: [] })
    expect(trimToolNamesToCap(names, 0)).toEqual({ kept: names, removed: [] })
    expect(trimToolNamesToCap(names, 5, { existingNames: ["skill_mcp", "todowrite"] })).toEqual({ kept: names, removed: [] })
    expect(trimToolNamesToCap(names, 6, { existingNames: ["skill_mcp", "todowrite"] })).toEqual({ kept: names, removed: [] })
  })

  test("drops the lowest-priority names first, counting the core surface toward the total", () => {
    // given: 5 core + 3 candidates = 8 total, cap 6 -> 2 must go
    const existing = ["session_list", "session_read", "look_at", "rigel_task", "skill_mcp"]
    const candidates = ["team_create", "team_send_message", "interactive_bash"]
    // when
    const { kept, removed } = trimToolNamesToCap(candidates, 6, { existingNames: existing })
    // then: session_list and session_read are the two lowest-priority names
    expect(removed.sort()).toEqual(["session_list", "session_read"])
    expect(kept.sort()).toEqual(["interactive_bash", "team_create", "team_send_message"])
  })

  test("falls back to alphabetical order for names outside the priority list", () => {
    // given: total 3, cap 2 -> 1 removal: skill_mcp is the only classified name
    const underCap = trimToolNamesToCap(["zeta", "alpha", "skill_mcp"], 2)
    expect(underCap.removed).toEqual(["skill_mcp"])
    expect(underCap.kept.sort()).toEqual(["alpha", "zeta"])
    // when: cap 1 -> skill_mcp (priority) then alpha (alphabetical) drop, zeta survives
    const atCap = trimToolNamesToCap(["zeta", "alpha", "skill_mcp"], 1)
    // then
    expect(atCap.removed.sort()).toEqual(["alpha", "skill_mcp"])
    expect(atCap.kept).toEqual(["zeta"])
  })

  test("the core surface itself is trimmable when the candidates are exhausted", () => {
    // given: 4 core + 1 candidate = 5 total, cap 3 -> 2 removals from the core
    const { kept, removed } = trimToolNamesToCap(["team_list"], 3, { existingNames: ["session_list", "session_read", "session_search", "look_at"] })
    // then
    expect(kept).toEqual(["team_list"])
    expect(removed.sort()).toEqual(["session_list", "session_read"])
  })
})
