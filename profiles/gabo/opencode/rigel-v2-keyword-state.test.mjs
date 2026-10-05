import { describe, expect, test } from "bun:test"
import { KEYWORD_STATE_CAP, createKeywordState } from "./rigel-v2-keyword-state.mjs"

describe("Rigel V2 keyword state: default-mode injected sessions", () => {
  test("remembers a session once and reports duplicates", () => {
    // given
    const state = createKeywordState()

    // when
    const first = state.rememberDefaultModeInjected("session-a")
    const second = state.rememberDefaultModeInjected("session-a")

    // then
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(state.hasDefaultModeInjected("session-a")).toBe(true)
  })

  test("evicts the oldest insertion at the 256 cap", () => {
    // given
    const state = createKeywordState()
    for (let index = 0; index < KEYWORD_STATE_CAP; index += 1) {
      state.rememberDefaultModeInjected(`session-${index}`)
    }

    // when
    const inserted = state.rememberDefaultModeInjected("session-256")

    // then
    expect(inserted).toBe(true)
    expect(state.hasDefaultModeInjected("session-0")).toBe(false)
    expect(state.hasDefaultModeInjected("session-1")).toBe(true)
    expect(state.hasDefaultModeInjected("session-255")).toBe(true)
    expect(state.hasDefaultModeInjected("session-256")).toBe(true)
  })

  test("re-remembering an existing session does not evict a neighbor", () => {
    // given
    const state = createKeywordState()
    for (let index = 0; index < KEYWORD_STATE_CAP; index += 1) {
      state.rememberDefaultModeInjected(`session-${index}`)
    }

    // when
    state.rememberDefaultModeInjected("session-0")

    // then
    expect(state.hasDefaultModeInjected("session-0")).toBe(true)
    expect(state.hasDefaultModeInjected("session-1")).toBe(true)
  })

  test("clears one session and ignores empty identifiers", () => {
    // given
    const state = createKeywordState()

    // when / then
    expect(state.rememberDefaultModeInjected("")).toBe(false)
    expect(state.rememberDefaultModeInjected(undefined)).toBe(false)
    state.rememberDefaultModeInjected("session-a")
    expect(state.clearDefaultModeInjected("session-a")).toBe(true)
    expect(state.hasDefaultModeInjected("session-a")).toBe(false)
  })
})

describe("Rigel V2 keyword state: explicit ultrawork records", () => {
  test("stores source and starts unmarked for restoration", () => {
    // given
    const state = createKeywordState()

    // when
    state.rememberExplicit("session-a", { source: "gpt" })

    // then
    expect(state.getExplicit("session-a")).toEqual({ source: "gpt", needsRestoration: false })
    expect(state.getExplicit("missing")).toBeUndefined()
  })

  test("evicts the oldest insertion at the 256 cap", () => {
    // given
    const state = createKeywordState()
    for (let index = 0; index < KEYWORD_STATE_CAP; index += 1) {
      state.rememberExplicit(`session-${index}`, { source: "default" })
    }

    // when
    state.rememberExplicit("session-256", { source: "gpt" })

    // then
    expect(state.getExplicit("session-0")).toBeUndefined()
    expect(state.getExplicit("session-255")).toBeDefined()
    expect(state.getExplicit("session-256")).toEqual({ source: "gpt", needsRestoration: false })
  })

  test("updating an existing session keeps its queue position and evicts the real oldest", () => {
    // given
    const state = createKeywordState()
    for (let index = 0; index < KEYWORD_STATE_CAP; index += 1) {
      state.rememberExplicit(`session-${index}`, { source: "default" })
    }

    // when: s0 is updated, then a new session arrives
    state.rememberExplicit("session-0", { source: "gpt" })
    state.rememberExplicit("session-256", { source: "glm" })

    // then: s0 was still the oldest insertion and is the one evicted
    expect(state.getExplicit("session-0")).toBeUndefined()
    expect(state.getExplicit("session-1")).toBeDefined()
    expect(state.getExplicit("session-256").source).toBe("glm")
  })

  test("marks a record for restoration while keeping its source", () => {
    // given
    const state = createKeywordState()
    state.rememberExplicit("session-a", { source: "gemini" })

    // when
    const marked = state.markNeedsRestoration("session-a")
    const missing = state.markNeedsRestoration("missing")

    // then
    expect(marked).toBe(true)
    expect(missing).toBe(false)
    expect(state.getExplicit("session-a")).toEqual({ source: "gemini", needsRestoration: true })
  })

  test("clearSession removes the explicit record only", () => {
    // given
    const state = createKeywordState()
    state.rememberExplicit("session-a", { source: "default" })
    state.rememberDefaultModeInjected("session-a")

    // when
    const removed = state.clearSession("session-a")

    // then
    expect(removed).toBe(true)
    expect(state.getExplicit("session-a")).toBeUndefined()
    expect(state.hasDefaultModeInjected("session-a")).toBe(true)
  })

  test("clearAll removes both stores", () => {
    // given
    const state = createKeywordState()
    state.rememberExplicit("session-a", { source: "default" })
    state.rememberDefaultModeInjected("session-a")

    // when
    state.clearAll()

    // then
    expect(state.getExplicit("session-a")).toBeUndefined()
    expect(state.hasDefaultModeInjected("session-a")).toBe(false)
  })

  test("ignores empty session identifiers", () => {
    // given / when / then
    const state = createKeywordState()
    expect(state.rememberExplicit("", { source: "default" })).toBe(false)
    expect(state.rememberExplicit(undefined, { source: "default" })).toBe(false)
  })
})

describe("Rigel V2 keyword state: events", () => {
  test("session.compacted marks the record for restoration", () => {
    // given
    const state = createKeywordState()
    state.rememberExplicit("session-a", { source: "gpt" })

    // when
    const handled = state.handleEvent({ type: "session.compacted", sessionID: "session-a" })

    // then
    expect(handled).toBe(true)
    expect(state.getExplicit("session-a").needsRestoration).toBe(true)
  })

  test("session.deleted clears both stores", () => {
    // given
    const state = createKeywordState()
    state.rememberExplicit("session-a", { source: "gpt" })
    state.rememberDefaultModeInjected("session-a")

    // when
    const handled = state.handleEvent({ type: "session.deleted", sessionID: "session-a" })

    // then
    expect(handled).toBe(true)
    expect(state.getExplicit("session-a")).toBeUndefined()
    expect(state.hasDefaultModeInjected("session-a")).toBe(false)
  })

  test("unknown events and missing session ids are not handled", () => {
    // given / when / then
    const state = createKeywordState()
    expect(state.handleEvent({ type: "session.idle", sessionID: "session-a" })).toBe(false)
    expect(state.handleEvent({ type: "session.deleted" })).toBe(false)
    expect(state.handleEvent({})).toBe(false)
  })
})

describe("Rigel V2 keyword state: restoration guidance", () => {
  function restoredState() {
    const state = createKeywordState()
    state.rememberExplicit("session-a", { source: "gpt" })
    state.markNeedsRestoration("session-a")
    return state
  }

  test("returns undefined until the record needs restoration", () => {
    // given
    const state = createKeywordState()
    state.rememberExplicit("session-a", { source: "gpt" })

    // when / then
    expect(state.getRestorationSource("session-a")).toBeUndefined()
    expect(state.getRestorationSource("missing")).toBeUndefined()
  })

  test("returns the recorded source when no model is supplied", () => {
    // given
    const state = restoredState()

    // when
    const source = state.getRestorationSource("session-a", { agent: "sisyphus" })

    // then
    expect(source).toBe("gpt")
  })

  test("re-derives the source from agent and model when a model is supplied", () => {
    // given
    const state = restoredState()

    // when / then
    expect(state.getRestorationSource("session-a", { agent: "sisyphus", modelID: "zai/glm-5" })).toBe("glm")
    expect(state.getRestorationSource("session-a", { agent: "plan-mode", modelID: "zai/glm-5" })).toBeUndefined()
  })

  test("skips planner, non-OMO, and subagent sessions", () => {
    // given
    const state = restoredState()

    // when / then
    expect(state.getRestorationSource("session-a", { agent: "prometheus" })).toBeUndefined()
    expect(state.getRestorationSource("session-a", { agent: "builder" })).toBeUndefined()
    expect(state.getRestorationSource("session-a", { isSubagentSession: true })).toBeUndefined()
  })

  test("resolves the message body through the supplied resolver", () => {
    // given
    const state = restoredState()
    const resolve = (source) => `BODY:${source}`

    // when
    const perCall = state.getRestoration("session-a", { messageForSource: resolve })
    const constructed = createKeywordState({ messageForSource: resolve })
    constructed.rememberExplicit("session-a", { source: "glm" })
    constructed.markNeedsRestoration("session-a")
    const viaConstructor = constructed.getRestoration("session-a", { agent: "sisyphus" })
    const bare = state.getRestoration("session-a", { source: "gpt" })

    // then
    expect(perCall).toEqual({ source: "gpt", message: "BODY:gpt" })
    expect(viaConstructor).toEqual({ source: "glm", message: "BODY:glm" })
    expect(bare).toEqual({ source: "gpt" })
    expect(state.getRestoration("session-a", { agent: "builder" })).toBeUndefined()
  })
})
