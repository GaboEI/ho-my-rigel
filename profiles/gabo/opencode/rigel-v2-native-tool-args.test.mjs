import { test, expect } from "bun:test"
import { patchToolArgs } from "./rigel-v2-native-tool-args.mjs"

// Upstream 34355b5bc: preserve tool argument identity, safe for frozen args.

test("a mutable input is patched in place and keeps its identity", () => {
  const input = { prompt: "old" }
  const event = { input }
  const result = patchToolArgs(event, (args) => { args.prompt = "new" })
  expect(result).toBe(input)
  expect(event.input).toBe(input)
  expect(input.prompt).toBe("new")
})

test("a frozen input is replaced by a clone carrying the patch, leaving the original untouched", () => {
  const frozen = Object.freeze({ prompt: "old" })
  const event = { input: frozen }
  const result = patchToolArgs(event, (args) => { args.prompt = "new" })
  expect(result).not.toBe(frozen)
  expect(event.input).toBe(result)
  expect(event.input.prompt).toBe("new")
  expect(frozen.prompt).toBe("old")
})

test("an args-shaped event (no input) is patched on the args field", () => {
  const args = { url: "http://a" }
  const event = { args }
  patchToolArgs(event, (value) => { value.url = "http://b" })
  expect(event.args.url).toBe("http://b")
})

test("delete works on a frozen clone and on a mutable object", () => {
  const frozen = Object.freeze({ overwrite: true, filePath: "x" })
  const frozenEvent = { input: frozen }
  patchToolArgs(frozenEvent, (args) => { delete args.overwrite })
  expect("overwrite" in frozenEvent.input).toBe(false)
  expect(frozenEvent.input.filePath).toBe("x")

  const mutable = { overwrite: true, filePath: "x" }
  const mutableEvent = { input: mutable }
  patchToolArgs(mutableEvent, (args) => { delete args.overwrite })
  expect("overwrite" in mutableEvent.input).toBe(false)
})

test("an event with no argument object is a no-op", () => {
  expect(patchToolArgs({}, () => {})).toBeUndefined()
  expect(patchToolArgs(undefined, () => {})).toBeUndefined()
})
