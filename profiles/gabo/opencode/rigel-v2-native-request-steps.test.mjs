/**
 * Hermetic tests for the Rigel native V2 ordered `http.request` rewrite steps.
 *
 * Every behavior is exercised positive AND negative. The tool-pair repair is
 * proven for BOTH provider shapes and proven idempotent. The stop-continuation
 * guard is proven to set the per-session state and block the continuation
 * injection. The image-resizer step is proven to gate on the provider set and to
 * rewrite chat and responses image parts through the injected resize.
 */

import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CONTINUATION_PROMPT_MARKER,
  createImageResizerStep,
  createStopContinuationState,
  imageResizerStep,
  readCurrentTurnText,
  repairChatToolPairs,
  repairResponsesToolPairs,
  requestSteps,
  resolveRequestShape,
  runRequestSteps,
  stopContinuationStep,
  stripContinuationInjection,
  toolPairValidatorStep,
} from "./rigel-v2-native-request-steps.mjs"

import { INTERRUPTED_TOOL_ERROR } from "./rigel-v2-flow-logic.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"

const OPENCODE_DIR = import.meta.dir

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function chatOrphanBody() {
  return {
    messages: [
      { role: "system", content: "system text" },
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_chat_1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
    ],
  }
}

function responsesOrphanBody() {
  return {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "read the file" }] },
      { type: "function_call", call_id: "call_resp_1", name: "read", arguments: "{}" },
    ],
  }
}

// ---------------------------------------------------------------------------
// 1. tool-pair-validator
// ---------------------------------------------------------------------------

describe("#given the tool-pair repair", () => {
  describe("#when a chat-shape body has an orphan tool call", () => {
    test("#then a terminal error result is inserted with the T9 interrupted text", () => {
      // given
      const body = chatOrphanBody()
      // when
      const repaired = repairChatToolPairs(body.messages)
      // then
      expect(repaired).toEqual(["call_chat_1"])
      expect(body.messages).toHaveLength(4)
      expect(body.messages[3]).toEqual({
        role: "tool",
        tool_call_id: "call_chat_1",
        content: INTERRUPTED_TOOL_ERROR,
      })
    })
  })

  describe("#when a responses-shape body has an orphan function call", () => {
    test("#then a function_call_output is inserted with the T9 interrupted text", () => {
      // given
      const body = responsesOrphanBody()
      // when
      const repaired = repairResponsesToolPairs(body.input)
      // then
      expect(repaired).toEqual(["call_resp_1"])
      expect(body.input).toHaveLength(3)
      expect(body.input[2]).toEqual({
        type: "function_call_output",
        call_id: "call_resp_1",
        output: INTERRUPTED_TOOL_ERROR,
      })
    })
  })

  describe("#when the repair runs twice", () => {
    test("#then the second pass is a no-op for both shapes (idempotent)", () => {
      // given
      const chat = chatOrphanBody()
      const responses = responsesOrphanBody()
      // when
      const firstChat = repairChatToolPairs(chat.messages)
      const firstResponses = repairResponsesToolPairs(responses.input)
      const chatSnapshot = JSON.stringify(chat)
      const responsesSnapshot = JSON.stringify(responses)
      const secondChat = repairChatToolPairs(chat.messages)
      const secondResponses = repairResponsesToolPairs(responses.input)
      // then
      expect(firstChat).toEqual(["call_chat_1"])
      expect(firstResponses).toEqual(["call_resp_1"])
      expect(secondChat).toEqual([])
      expect(secondResponses).toEqual([])
      expect(JSON.stringify(chat)).toBe(chatSnapshot)
      expect(JSON.stringify(responses)).toBe(responsesSnapshot)
    })
  })

  describe("#when every tool call is already paired", () => {
    test("#then nothing is repaired", () => {
      // given
      const body = {
        messages: [
          { role: "assistant", content: null, tool_calls: [{ id: "call_ok", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_ok", content: "file text" },
        ],
      }
      // when / then
      expect(repairChatToolPairs(body.messages)).toEqual([])
      expect(body.messages).toHaveLength(2)
    })

    test("#then a non-array body yields an empty list", () => {
      // given / when / then
      expect(repairChatToolPairs(null)).toEqual([])
      expect(repairResponsesToolPairs(undefined)).toEqual([])
    })
  })

  describe("#when the step runs over a body", () => {
    test("#then it resolves the shape and reports the repaired ids", () => {
      // given
      const chat = chatOrphanBody()
      const responses = responsesOrphanBody()
      // when / then
      expect(toolPairValidatorStep.run({ body: chat })).toEqual({ shape: "chat", repaired: ["call_chat_1"] })
      expect(toolPairValidatorStep.run({ body: responses })).toEqual({ shape: "responses", repaired: ["call_resp_1"] })
      expect(toolPairValidatorStep.run({ body: {} })).toEqual({ shape: undefined, repaired: [] })
    })
  })

  describe("#when resolving the provider shape", () => {
    test("#then messages is chat, input is responses, and neither is undefined", () => {
      // given / when / then
      expect(resolveRequestShape({ messages: [] })).toBe("chat")
      expect(resolveRequestShape({ input: [] })).toBe("responses")
      expect(resolveRequestShape({})).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// 2. stop-continuation-guard
// ---------------------------------------------------------------------------

describe("#given the stop-continuation guard", () => {
  describe("#when the current turn is /stop-continuation", () => {
    test("#then the session is stopped and the continuation injection is blocked", () => {
      // given
      const stopState = createStopContinuationState()
      const body = {
        messages: [
          { role: "user", content: `${CONTINUATION_PROMPT_MARKER}\n\n<untrusted_objective>keep going</untrusted_objective>` },
          { role: "user", content: "/stop-continuation" },
        ],
      }
      // when
      const result = stopContinuationStep.run({ body, shape: "chat", sessionID: "ses_stop", stopState })
      // then
      expect(result).toEqual({ stopped: true, blocked: 1 })
      expect(stopState.isStopped("ses_stop")).toBe(true)
      expect(body.messages).toHaveLength(1)
      expect(body.messages[0].content).toBe("/stop-continuation")
    })

    test("#then the responses shape is blocked the same way", () => {
      // given
      const stopState = createStopContinuationState()
      const body = {
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: CONTINUATION_PROMPT_MARKER }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "/stop-continuation" }] },
        ],
      }
      // when
      const result = stopContinuationStep.run({ body, shape: "responses", sessionID: "ses_stop_r", stopState })
      // then
      expect(result).toEqual({ stopped: true, blocked: 1 })
      expect(body.input).toHaveLength(1)
    })
  })

  describe("#when the session is not stopped", () => {
    test("#then the continuation injection is left alone", () => {
      // given
      const stopState = createStopContinuationState()
      const body = {
        messages: [
          { role: "user", content: "keep working" },
          { role: "user", content: CONTINUATION_PROMPT_MARKER },
        ],
      }
      // when
      const result = stopContinuationStep.run({ body, shape: "chat", sessionID: "ses_live", stopState })
      // then
      expect(result).toEqual({ stopped: false, blocked: 0 })
      expect(body.messages).toHaveLength(2)
    })

    test("#then a missing stop state is a no-op", () => {
      // given
      const body = { messages: [{ role: "user", content: "/stop-continuation" }] }
      // when / then
      expect(stopContinuationStep.run({ body, shape: "chat", sessionID: "ses_x" })).toEqual({ stopped: false, blocked: 0 })
    })
  })

  describe("#when the session is cleared", () => {
    test("#then isStopped is false again", () => {
      // given
      const stopState = createStopContinuationState()
      stopState.stop("ses_clear")
      // when
      stopState.clear("ses_clear")
      // then
      expect(stopState.isStopped("ses_clear")).toBe(false)
    })
  })

  describe("#when reading the current turn text", () => {
    test("#then the last user message is returned for both shapes", () => {
      // given
      const chat = { messages: [{ role: "user", content: "first" }, { role: "assistant", content: "x" }, { role: "user", content: "last" }] }
      const responses = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "last" }] }] }
      // when / then
      expect(readCurrentTurnText(chat, "chat")).toBe("last")
      expect(readCurrentTurnText(responses, "responses")).toBe("last")
      expect(readCurrentTurnText({}, "chat")).toBe("")
    })
  })

  describe("#when stripping the continuation injection", () => {
    test("#then only the continuation message is removed", () => {
      // given
      const body = { messages: [{ role: "user", content: "keep" }, { role: "user", content: CONTINUATION_PROMPT_MARKER }] }
      // when
      const removed = stripContinuationInjection(body, "chat")
      // then
      expect(removed).toBe(1)
      expect(body.messages).toEqual([{ role: "user", content: "keep" }])
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Ordered pipeline
// ---------------------------------------------------------------------------

describe("#given the ordered request steps", () => {
  test("#then HTTP owns only the image transport step", () => {
    // given / when / then
    expect(requestSteps.map((step) => step.name)).toEqual(["image-resizer"])
    expect(Object.isFrozen(requestSteps)).toBe(true)
  })

  test("#when runRequestSteps drives the HTTP pipeline #then image transport remains isolated", async () => {
    // given
    const body = chatOrphanBody()
    // when
    const report = await runRequestSteps({ body, shape: "chat", sessionID: "ses_pipe" })
    // then
    expect(report.executed).toEqual(["image-resizer"])
    expect(report.failures).toEqual([])
    expect(body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_chat_1")).toBe(false)
  })

  test("#when a step throws #then the pipeline isolates it and keeps running", async () => {
    // given
    const stopState = createStopContinuationState()
    const body = { messages: [{ role: "user", content: "/stop-continuation" }] }
    const throwing = { name: "throwing-step", run: () => { throw new Error("boom") } }
    // when
    const report = await runRequestSteps({ body, shape: "chat", sessionID: "ses_iso", stopState }, [throwing, stopContinuationStep])
    // then
    expect(report.executed).toEqual(["stop-continuation-guard"])
    expect(report.failures.map((failure) => failure.name)).toEqual(["throwing-step"])
    expect(stopState.isStopped("ses_iso")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. image-resizer step
// ---------------------------------------------------------------------------

function chatImageBody(url) {
  return { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] }
}

function responsesImageBody(url) {
  return { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: url }] }] }
}

function responsesFunctionOutputBody(url) {
  return { input: [{ type: "function_call_output", call_id: "call_img_1", output: [{ type: "input_image", image_url: url }] }] }
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async function pngDataUrlFor(width, height) {
  const image = await new Bun.Image(Buffer.from(TINY_PNG_BASE64, "base64")).resize(width, height, { fit: "fill" })
  const bytes = Buffer.from(await (await image.png()).toBuffer())
  return `data:image/png;base64,${bytes.toString("base64")}`
}

const LARGE_PNG_DATA_URL = await pngDataUrlFor(2000, 1000)
const SMALL_PNG_DATA_URL = await pngDataUrlFor(800, 600)

function silentLogger() {
  const calls = []
  return { calls, error: (message) => calls.push(message) }
}

describe("#given the image-resizer step", () => {
  test("#then it is the last wired step", () => {
    // given / when / then
    expect(requestSteps.at(-1)).toBe(imageResizerStep)
    expect(imageResizerStep.name).toBe("image-resizer")
  })

  test("#when the provider is not in the resizer set #then it skips and leaves the body untouched", async () => {
    // given
    const body = chatImageBody(LARGE_PNG_DATA_URL)
    const step = createImageResizerStep({ providers: ["anthropic"], log: silentLogger() })
    // when
    const result = await step.run({ body, shape: "chat", input: { model: { providerID: "opencode-go" } } })
    // then
    expect(result.skipped).toBe("provider")
    expect(body.messages[0].content[0].image_url.url).toBe(LARGE_PNG_DATA_URL)
  })

  test("#when the provider matches #then a chat image part is resized in place", async () => {
    // given
    const body = chatImageBody(LARGE_PNG_DATA_URL)
    const calls = []
    const resize = async (url, mime) => {
      calls.push({ url, mime })
      return { resized: true, dataUrl: "data:image/png;base64,NEW" }
    }
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: silentLogger() })
    // when
    const result = await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result.resized).toBe(1)
    expect(result.removed).toBe(0)
    expect(calls).toEqual([{ url: LARGE_PNG_DATA_URL, mime: "image/png" }])
    expect(body.messages[0].content[0].image_url.url).toBe("data:image/png;base64,NEW")
  })

  test("#when the provider matches #then a responses input_image part is resized in place", async () => {
    // given
    const body = responsesImageBody(LARGE_PNG_DATA_URL)
    const resize = async () => ({ resized: true, dataUrl: "data:image/png;base64,NEW" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: silentLogger() })
    // when
    const result = await step.run({ body, shape: "responses", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result.resized).toBe(1)
    expect(body.input[0].content[0].image_url).toBe("data:image/png;base64,NEW")
  })

  test("#when a Responses function-call output carries an oversized image #then it is resized in place", async () => {
    // given: `input_image` content parts are also valid inside a
    // function_call_output `output[]` array, not only inside message content.
    const body = responsesFunctionOutputBody(LARGE_PNG_DATA_URL)
    const resize = async () => ({ resized: true, dataUrl: "data:image/png;base64,NEW" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: silentLogger() })
    // when
    const result = await step.run({ body, shape: "responses", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result.resized).toBe(1)
    expect(body.input[0].output[0].image_url).toBe("data:image/png;base64,NEW")
  })

  test("#when a Responses function-call output image fails to resize #then it is removed and the note is added", async () => {
    // given
    const body = responsesFunctionOutputBody(LARGE_PNG_DATA_URL)
    const resize = async () => ({ resized: false, reason: "resize-failed" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: silentLogger() })
    // when
    const result = await step.run({ body, shape: "responses", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result.removed).toBe(1)
    expect(body.input[0].output).toHaveLength(0)
    const noteItem = body.input.find((item) => item?.type === "message" && item?.role === "system")
    expect(Boolean(noteItem)).toBe(true)
  })

  test("#when an image is within limits #then it is left untouched and no note is added", async () => {
    // given
    const body = chatImageBody(SMALL_PNG_DATA_URL)
    const logger = silentLogger()
    const resize = async () => { throw new Error("resize must not run for a within-limits image") }
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: logger })
    // when
    const result = await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result.resized).toBe(0)
    expect(result.removed).toBe(0)
    expect(body.messages.length).toBe(1)
    expect(body.messages[0].content[0].image_url.url).toBe(SMALL_PNG_DATA_URL)
    expect(logger.calls).toEqual([])
  })

  test("#when a required resize fails #then the part is removed, a visible note is added, and the failure is logged", async () => {
    // given
    const body = chatImageBody(LARGE_PNG_DATA_URL)
    const logger = silentLogger()
    const resize = async () => ({ resized: false, reason: "resize-failed" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: logger })
    // when
    const result = await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result.removed).toBe(1)
    expect(result.resized).toBe(0)
    const userMessage = body.messages.find((message) => Array.isArray(message.content))
    expect(userMessage.content.length).toBe(0)
    const note = body.messages.find((message) => typeof message.content === "string" && message.content.includes("[Image Resize Info]"))
    expect(Boolean(note)).toBe(true)
    expect(note.content).toContain("image removed to prevent API error")
    expect(logger.calls.length).toBe(1)
    expect(logger.calls[0]).toContain("removed 1 oversized image")
  })

  test("#when a required Responses resize fails #then the notice is an input_text item in body.input, not instructions", async () => {
    // given
    const body = responsesImageBody(LARGE_PNG_DATA_URL)
    const logger = silentLogger()
    const resize = async () => ({ resized: false, unavailable: true, reason: "Bun.Image unavailable" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: logger })
    // when
    const result = await step.run({ body, shape: "responses", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result.removed).toBe(1)
    const userItem = body.input.find((item) => item?.role === "user")
    expect(userItem.content.length).toBe(0)
    expect(body.instructions).toBeUndefined()
    const noteItem = body.input.find((item) => item?.type === "message" && item?.role === "system"
      && Array.isArray(item.content) && item.content.some((part) => part?.type === "input_text" && part.text.includes("[Image Resize Info]")))
    expect(Boolean(noteItem)).toBe(true)
    expect(noteItem.content[0].type).toBe("input_text")
    expect(body.input.indexOf(noteItem)).toBeGreaterThan(body.input.indexOf(userItem))
    expect(logger.calls.length).toBe(1)
  })

  test("#when the step runs twice on a failed Responses image #then the notice is not duplicated", async () => {
    // given
    const body = responsesImageBody(LARGE_PNG_DATA_URL)
    const resize = async () => ({ resized: false, reason: "resize-failed" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: silentLogger() })
    // when
    await step.run({ body, shape: "responses", input: { model: { providerID: "anthropic" } } })
    await step.run({ body, shape: "responses", input: { model: { providerID: "anthropic" } } })
    // then
    const notes = body.input.filter((item) => item?.type === "message" && item?.role === "system")
    expect(notes.length).toBe(1)
  })

  test("#when the step runs twice on a failed chat image #then the notice is not duplicated", async () => {
    // given
    const body = chatImageBody(LARGE_PNG_DATA_URL)
    const resize = async () => ({ resized: false, reason: "resize-failed" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: silentLogger() })
    // when
    await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })
    await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })
    // then
    const notes = body.messages.filter((message) => message?.role === "system" && typeof message.content === "string" && message.content.includes("[Image Resize Info]"))
    expect(notes.length).toBe(1)
  })

  test("#when there are no image parts #then nothing is considered", async () => {
    // given
    const body = { messages: [{ role: "user", content: "no images here" }] }
    const step = createImageResizerStep({ providers: ["anthropic"], log: silentLogger() })
    // when
    const result = await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })
    // then
    expect(result).toEqual({ considered: 0, resized: 0, removed: 0, skips: [] })
  })

  test("#when runRequestSteps runs #then per-step results are returned, not discarded", async () => {
    // given
    const stopState = createStopContinuationState()
    const body = chatImageBody(LARGE_PNG_DATA_URL)
    const resize = async () => ({ resized: false, reason: "resize-failed" })
    const step = createImageResizerStep({ providers: ["anthropic"], resize, log: silentLogger() })
    // when
    const report = await runRequestSteps(
      { body, shape: "chat", sessionID: "ses_r", stopState, input: { model: { providerID: "anthropic" } } },
      [toolPairValidatorStep, stopContinuationStep, step],
    )
    // then
    expect(report.results.map((entry) => entry.name)).toEqual(["tool-pair-validator", "stop-continuation-guard", "image-resizer"])
    expect(report.results.find((entry) => entry.name === "image-resizer").result.removed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. stop-continuation transition callbacks (T20 phase-4 parity)
// ---------------------------------------------------------------------------

describe("#given a stop-continuation state with transition callbacks", () => {
  test("#when stop and clear repeat #then each callback fires only on its transition", () => {
    // given
    const stops = []
    const clears = []
    const state = createStopContinuationState({
      onStop: (sessionID) => stops.push(sessionID),
      onClear: (sessionID) => clears.push(sessionID),
    })
    // when
    state.stop("ses_a")
    state.stop("ses_a")
    state.stop("ses_a")
    state.clear("ses_a")
    state.clear("ses_a")
    state.clear("ses_b")
    // then
    expect(stops).toEqual(["ses_a"])
    expect(clears).toEqual(["ses_a"])
    expect(state.isStopped("ses_a")).toBe(false)
  })

  test("#when onStop throws synchronously #then stop still records the stopped session", () => {
    // given
    const state = createStopContinuationState({ onStop: () => { throw new Error("boom") } })
    // when / then
    expect(() => state.stop("ses_throw")).not.toThrow()
    expect(state.isStopped("ses_throw")).toBe(true)
  })

  test("#when onStop rejects asynchronously #then the rejection is swallowed", async () => {
    // given
    const state = createStopContinuationState({ onStop: async () => { throw new Error("async boom") } })
    // when
    state.stop("ses_async")
    await Promise.resolve()
    // then
    expect(state.isStopped("ses_async")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Named-RED mutation harness
// ---------------------------------------------------------------------------

describe("Rigel V2 request-steps named-RED mutation harness", () => {
  test("#given stop() drops its transition guard #when the contract runs #then it turns RED and restores byte-identically", async () => {
    // given: an isolated copy of the module tree so relative imports resolve.
    const root = mkdtempSync(join(tmpdir(), "rigel-steps-mutant-"))
    const directory = join(root, "opencode")
    cpSync(OPENCODE_DIR, directory, { recursive: true })
    const target = join(directory, "rigel-v2-native-request-steps.mjs")
    const before = readFileSync(target)

    // when
    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace("      if (stoppedSessions.has(sessionID)) return\n", ""),
      contract: {
        name: "stop-continuation state fires onStop only on the not-stopped -> stopped transition",
        run: async ({ load }) => {
          const module = await load()
          let count = 0
          const state = module.createStopContinuationState({ onStop: () => { count += 1 } })
          state.stop("s")
          state.stop("s")
          if (count !== 1) throw new Error(`expected onStop once across repeated stop, got ${count}`)
        },
      },
    })

    // then
    expect(receipt.contract).toBe("stop-continuation state fires onStop only on the not-stopped -> stopped transition")
    expect(receipt.red).toBe(true)
    expect(receipt.redError).toContain("expected onStop once")
    expect(receipt.beforeHash).toBe(receipt.afterHash)
    expect(readFileSync(target).equals(before)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})
