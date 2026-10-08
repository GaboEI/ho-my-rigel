import { test, expect } from "bun:test"
import { getStoppedSessionError, getStoppedSessionErrorInfo } from "./rigel-v2-background-stopped.mjs"

// Port of V1 `session-stopped-on-error.ts` (upstream a0b2e96c3), event-driven.

test("returns a described error for a latest errored assistant turn", () => {
  expect(getStoppedSessionError([
    { info: { role: "user" } },
    { info: { role: "assistant", error: { name: "ProviderError", data: { message: "429 Too Many Requests" } } } },
  ])).toBe("ProviderError: 429 Too Many Requests")
})

test("returns undefined when the latest turn is not an errored assistant", () => {
  expect(getStoppedSessionError([{ info: { role: "assistant" } }])).toBeUndefined()
  expect(getStoppedSessionError([{ info: { role: "user" } }])).toBeUndefined()
  expect(getStoppedSessionError([{ info: { role: "assistant", error: null } }])).toBeUndefined()
  expect(getStoppedSessionError([])).toBeUndefined()
  expect(getStoppedSessionError(undefined)).toBeUndefined()
})

test("accepts a bare { role, error } message and falls back to error.message/name", () => {
  expect(getStoppedSessionError([{ role: "assistant", error: { message: "boom" } }])).toBe("boom")
  expect(getStoppedSessionError([{ info: { role: "assistant", error: "plain" } }])).toBe("plain")
  expect(getStoppedSessionError([{ info: { role: "assistant", error: {} } }])).toBe("unknown error")
})

test("getStoppedSessionErrorInfo returns the RAW error so the retry classifier can read name/status", () => {
  const error = { name: "RateLimitError", message: "rate limit", data: { statusCode: 429 } }
  expect(getStoppedSessionErrorInfo([{ info: { role: "assistant", error } }])).toBe(error)
  expect(getStoppedSessionErrorInfo([{ info: { role: "user" } }])).toBeUndefined()
  expect(getStoppedSessionErrorInfo([{ info: { role: "assistant", error: null } }])).toBeUndefined()
})

// The real V2 transcript is flat (`{ type }`, no `.info`) and the host appends an
// `idle` (and after a fallback a `model-switched`) marker after every turn end, so
// the reader must walk back over those non-turn markers to reach the turn.
test("reads the real flat V2 transcript: errored assistant under a trailing idle marker", () => {
  const error = { type: "provider.internal", message: "child provider boom 500", status: 500 }
  const messages = [
    { type: "user" },
    { type: "assistant", finish: "error", error },
    { type: "idle" },
    { type: "model-switched" },
  ]
  expect(getStoppedSessionErrorInfo(messages)).toBe(error)
  expect(getStoppedSessionError(messages)).toBe("provider.internal: child provider boom 500")
})

test("returns undefined when the real V2 transcript has no errored assistant before a later turn", () => {
  expect(getStoppedSessionErrorInfo([{ type: "user" }, { type: "assistant", finish: "stop" }, { type: "idle" }])).toBeUndefined()
  expect(getStoppedSessionErrorInfo([{ type: "assistant", error: { type: "x", message: "y" } }, { type: "user" }])).toBeUndefined()
  expect(getStoppedSessionErrorInfo([{ type: "system" }, { type: "idle" }])).toBeUndefined()
  expect(getStoppedSessionErrorInfo([{ type: "synthetic" }, { type: "idle" }])).toBeUndefined()
})

test("describeSessionError falls back to the V2 error `type` when `name` is absent", () => {
  expect(getStoppedSessionError([{ type: "assistant", error: { type: "provider.invalid-request", message: "bad" } }])).toBe("provider.invalid-request: bad")
})

