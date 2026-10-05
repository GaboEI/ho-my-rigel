/**
 * Hermetic tests for the Rigel native V2 compaction-context module.
 *
 * The prompt is proven byte-identical to the V1 template parsed at test time
 * (the marker from `shared/system-directive.ts` and the template literal from
 * `compaction-context-prompt.ts`), never against a second hardcoded copy. The
 * history formatter, the provider classifier, the A1 hook, and the A2 step are
 * each exercised positive and negative, including idempotency.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  COMPACTION_CONTEXT_MARKER,
  COMPACTION_CONTEXT_PROMPT,
  buildCompactionContextBlock,
  classifyProviderRequest,
  createCompactionContextStep,
  createNativeCompactionContextHook,
  formatDelegatedSessionHistory,
  noteCompactionRestoration,
} from "./rigel-v2-native-compaction-context.mjs"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DIRECTIVE_SOURCE = join(REPO_ROOT, "packages", "omo-opencode", "src", "shared", "system-directive.ts")
const PROMPT_SOURCE = join(
  REPO_ROOT,
  "packages",
  "omo-opencode",
  "src",
  "hooks",
  "compaction-context-injector",
  "compaction-context-prompt.ts",
)

function expectedMarkerFromV1() {
  const source = readFileSync(DIRECTIVE_SOURCE, "utf8")
  const prefix = /export const SYSTEM_DIRECTIVE_PREFIX = "([^"]+)"/.exec(source)
  const type = /COMPACTION_CONTEXT:\s*"([^"]+)"/.exec(source)
  if (!prefix || !type) throw new Error("could not parse the V1 system directive constants")
  return `${prefix[1]} - ${type[1]}]`
}

function expectedPromptFromV1() {
  const source = readFileSync(PROMPT_SOURCE, "utf8")
  const opener = "export const COMPACTION_CONTEXT_PROMPT = `"
  const start = source.indexOf(opener)
  if (start === -1) throw new Error("could not find the V1 prompt declaration")
  const raw = source.slice(start + opener.length, source.lastIndexOf("`"))
  return raw
    .replace("${createSystemDirective(SystemDirectiveTypes.COMPACTION_CONTEXT)}", expectedMarkerFromV1())
    .replace(/\\`/g, "`")
}

function delegatedEntry(index, overrides = {}) {
  return {
    taskId: `t${index}`,
    agent: "explore",
    status: "completed",
    resultStatus: "completed",
    prompt: `Task ${index}`,
    sessionID: `ses_child_${index}`,
    ...overrides,
  }
}

function chatBody(messages) {
  return { messages }
}

function responsesBody(input) {
  return { input }
}

// ---------------------------------------------------------------------------
// 1. Prompt and marker
// ---------------------------------------------------------------------------

describe("#given the compaction-context prompt port", () => {
  describe("#when the V1 sources are parsed at test time", () => {
    test("#then the exported prompt is byte-identical to the V1 template", () => {
      // given
      const expectedPrompt = expectedPromptFromV1()
      const expectedMarker = expectedMarkerFromV1()
      // when / then
      expect(COMPACTION_CONTEXT_PROMPT).toBe(expectedPrompt)
      expect(COMPACTION_CONTEXT_MARKER).toBe(expectedMarker)
      expect(COMPACTION_CONTEXT_PROMPT.startsWith(COMPACTION_CONTEXT_MARKER)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// 2. formatDelegatedSessionHistory
// ---------------------------------------------------------------------------

describe("#given the delegated session history formatter", () => {
  describe("#when there are no delegated sessions", () => {
    test("#then it returns null (V1 parity)", () => {
      // given / when / then
      expect(formatDelegatedSessionHistory([])).toBeNull()
      expect(formatDelegatedSessionHistory(undefined)).toBeNull()
      expect(formatDelegatedSessionHistory(null)).toBeNull()
    })
  })

  describe("#when more than 20 sessions are recorded", () => {
    test("#then only the most recent 20 are kept with an older-omitted summary", () => {
      // given
      const entries = Array.from({ length: 21 }, (_, index) => delegatedEntry(index))
      // when
      const result = formatDelegatedSessionHistory(entries)
      // then
      expect(result).not.toBeNull()
      const lines = result.split("\n")
      expect(lines[0]).toBe("- 1 older delegated sessions omitted from compaction summary.")
      expect(lines.filter((line) => line.startsWith("- **"))).toHaveLength(20)
      expect(result).toContain("`t20`")
      expect(result).not.toContain("`t0`")
    })
  })

  describe("#when a description is long and multi-line", () => {
    test("#then whitespace collapses and the description truncates at 240 chars", () => {
      // given
      const description = `Line1\nLine2   Line3 ${"x".repeat(400)}`
      const entries = [delegatedEntry(1, { prompt: description })]
      // when
      const result = formatDelegatedSessionHistory(entries)
      // then
      expect(result).toContain("Line1 Line2 Line3")
      expect(result).toContain("[truncated]")
      const descriptionStart = result.indexOf("`: ") + 3
      const descriptionEnd = result.indexOf(" | session:")
      const descriptionPart = result.slice(descriptionStart, descriptionEnd === -1 ? undefined : descriptionEnd)
      expect(descriptionPart.length).toBeLessThanOrEqual(240)
    })
  })

  describe("#when the history exceeds the total compaction budget", () => {
    test("#then output stays within 6000 chars and drops older lines with a budget summary", () => {
      // given
      const longDescription = "Inspect the same lengthy failure context. ".repeat(200)
      const entries = Array.from({ length: 100 }, (_, index) =>
        delegatedEntry(index, {
          agent: "explore",
          category: "quick",
          prompt: `${longDescription} task ${index}`,
          sessionID: `ses_child_${index}`,
        }),
      )
      // when
      const result = formatDelegatedSessionHistory(entries)
      // then
      expect(result).not.toBeNull()
      expect(result.length).toBeLessThanOrEqual(6_000)
      expect(result).toContain("older delegated sessions omitted")
      expect(result).toContain("[truncated]")
      expect(result).toContain("`t99`")
      expect(result).not.toContain("`t0`")
      expect(result).toContain("delegated sessions omitted to stay within compaction budget")
    })
  })

  describe("#when the entry fields are mapped from a background-manager record", () => {
    test("#then resultStatus wins over status and prompt supplies the description", () => {
      // given
      const entries = [
        { taskId: "t_alpha", agent: "oracle", status: "running", resultStatus: "completed", prompt: "Review architecture", category: "deep" },
      ]
      // when
      const result = formatDelegatedSessionHistory(entries)
      // then
      expect(result).toContain("**oracle**")
      expect(result).toContain("[deep]")
      expect(result).toContain("(completed)")
      expect(result).toContain("`t_alpha`")
      expect(result).toContain("Review architecture")
    })
  })
})

// ---------------------------------------------------------------------------
// 3. buildCompactionContextBlock
// ---------------------------------------------------------------------------

describe("#given the compaction context block builder", () => {
  describe("#when no history is supplied", () => {
    test("#then it returns the template only", () => {
      // given / when / then
      expect(buildCompactionContextBlock()).toBe(COMPACTION_CONTEXT_PROMPT)
      expect(buildCompactionContextBlock({ history: null })).toBe(COMPACTION_CONTEXT_PROMPT)
      expect(buildCompactionContextBlock({ history: "" })).toBe(COMPACTION_CONTEXT_PROMPT)
    })
  })

  describe("#when history is supplied", () => {
    test("#then it appends the delegated-session section with leading and trailing newlines", () => {
      // given
      const history = "- **explore** (completed) task_id: `t1`: Find auth"
      // when
      const block = buildCompactionContextBlock({ history })
      // then
      expect(block).toBe(`${COMPACTION_CONTEXT_PROMPT}\n### Active/Recent Delegated Sessions\n${history}\n`)
    })
  })
})

// ---------------------------------------------------------------------------
// 4. classifyProviderRequest
// ---------------------------------------------------------------------------

describe("#given the provider request classifier", () => {
  describe("#when an explicit kind is supplied", () => {
    test("#then the kind wins over the heuristics", () => {
      // given
      const body = chatBody([{ role: "user", content: "hello" }])
      // when / then
      expect(classifyProviderRequest({ body, kind: "compaction" })).toBe("compaction")
      expect(classifyProviderRequest({ body, kind: "child" })).toBe("child")
      expect(classifyProviderRequest({ body, kind: "other" })).toBe("other")
      expect(classifyProviderRequest({ body, kind: "title" })).toBe("title")
    })
  })

  describe("#when a chat body has a title-generator system message", () => {
    test("#then it is classified as title", () => {
      // given
      const body = chatBody([
        { role: "system", content: "You are a title generator. Produce a short title." },
        { role: "user", content: "summarize the repo" },
      ])
      // when / then
      expect(classifyProviderRequest({ body })).toBe("title")
    })
  })

  describe("#when the last chat user message carries a compaction prefix", () => {
    test("#then all three V1 prefixes classify as compaction", () => {
      // given
      const prefixes = [
        "You MUST summarize the session now.",
        "Update the existing checkpoint with the latest state.",
        "The previous response did not fill the requested output.",
      ]
      // when / then
      for (const content of prefixes) {
        expect(classifyProviderRequest({ body: chatBody([{ role: "user", content }]) })).toBe("compaction")
      }
    })
  })

  describe("#when the last responses user item carries a compaction prefix", () => {
    test("#then it is classified as compaction over the string content shape", () => {
      // given
      const body = responsesBody([
        { type: "message", role: "user", content: "first turn" },
        { type: "message", role: "user", content: "You MUST summarize the session" },
      ])
      // when / then
      expect(classifyProviderRequest({ body })).toBe("compaction")
    })

    test("#then it is classified as compaction over the input_text parts shape", () => {
      // given
      const body = responsesBody([
        { type: "message", role: "user", content: [{ type: "input_text", text: "first turn" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "The previous response did not fill the output" }] },
      ])
      // when / then
      expect(classifyProviderRequest({ body })).toBe("compaction")
    })

    test("#then a responses title-generator system item is classified as title", () => {
      // given
      const body = responsesBody([
        { type: "message", role: "system", content: [{ type: "input_text", text: "You are a title generator" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ])
      // when / then
      expect(classifyProviderRequest({ body })).toBe("title")
    })
  })

  describe("#when the body carries the child-task marker", () => {
    test("#then it is other, not compaction, unless the kind says compaction", () => {
      // given
      const body = chatBody([{ role: "user", content: "<rigel-native-child-task> do the work" }])
      // when / then
      expect(classifyProviderRequest({ body })).toBe("other")
      expect(classifyProviderRequest({ body, kind: "compaction" })).toBe("compaction")
    })
  })

  describe("#when the body shape is unknown", () => {
    test("#then it is classified as other", () => {
      // given / when / then
      expect(classifyProviderRequest()).toBe("other")
      expect(classifyProviderRequest({})).toBe("other")
      expect(classifyProviderRequest({ body: { foo: 1 } })).toBe("other")
      expect(classifyProviderRequest({ body: { messages: "not-an-array" } })).toBe("other")
    })
  })
})

// ---------------------------------------------------------------------------
// 5. A1 messages hook
// ---------------------------------------------------------------------------

describe("#given the native compaction-context hook", () => {
  describe("#when it runs on a messages array", () => {
    test("#then it pushes one marker-bearing user message and is idempotent", async () => {
      // given
      const event = { messages: [{ role: "user", content: "hello" }] }
      const hook = createNativeCompactionContextHook()
      // when
      await hook(event)
      // then
      expect(event.messages).toHaveLength(2)
      expect(event.messages[1].role).toBe("user")
      // V2 message-info content is an array of typed parts; a string content
      // crashes SessionCompaction.compact in SessionModelRequest.prepare.
      expect(event.messages[1].content).toEqual([{ type: "text", text: expect.stringContaining(COMPACTION_CONTEXT_MARKER) }])
      // when: the hook runs again on the same array
      const afterFirst = event.messages.length
      await hook(event)
      // then: no duplicate
      expect(event.messages).toHaveLength(afterFirst)
      const injected = event.messages.filter(
        (message) => Array.isArray(message.content) && message.content.some((part) => part?.text?.includes(COMPACTION_CONTEXT_MARKER)),
      )
      expect(injected).toHaveLength(1)
    })
  })

  describe("#when the messages already carry the marker as V2 content parts", () => {
    test("#then the hook does not inject a second block", async () => {
      // given: the live V2 messages shape (content is an array of typed parts)
      const hook = createNativeCompactionContextHook()
      const event = { messages: [{ role: "user", content: [{ type: "text", text: `prefix ${COMPACTION_CONTEXT_MARKER} suffix` }] }] }
      // when
      await hook(event)
      // then
      expect(event.messages).toHaveLength(1)
    })
  })

  describe("#when the event has no messages array", () => {
    test("#then it is a no-op", async () => {
      // given
      const hook = createNativeCompactionContextHook()
      const event = {}
      // when / then
      await hook(event)
      expect(event.messages).toBeUndefined()
      await hook(undefined)
      await hook(null)
    })
  })

  describe("#when a getHistory reader is injected", () => {
    test("#then the block carries the session history section", async () => {
      // given
      const seen = []
      const hook = createNativeCompactionContextHook({
        getHistory: (sessionID) => {
          seen.push(sessionID)
          return "- **explore** [quick] (running) task_id: `t1`"
        },
      })
      const event = { sessionID: "ses_parent", messages: [] }
      // when
      await hook(event)
      // then: the delegated-sessions section rides on the same block
      expect(seen).toEqual(["ses_parent"])
      expect(event.messages[0].content[0].text).toContain("### Active/Recent Delegated Sessions")
      expect(event.messages[0].content[0].text).toContain("task_id: `t1`")
    })
  })

  describe("#when a custom buildBlock is injected", () => {
    test("#then the hook uses it", async () => {
      // given
      const hook = createNativeCompactionContextHook({ buildBlock: () => "CUSTOM BLOCK" })
      const event = { messages: [] }
      // when
      await hook(event)
      // then
      expect(event.messages).toEqual([{ role: "user", content: [{ type: "text", text: "CUSTOM BLOCK" }] }])
    })
  })
})

// ---------------------------------------------------------------------------
// 6. A2 request step
// ---------------------------------------------------------------------------

describe("#given the compaction-context request step", () => {
  test("#then it carries the V1 step name", () => {
    // given / when / then
    expect(createCompactionContextStep().name).toBe("compaction-context-injector")
  })

  describe("#when a chat compaction request is injected", () => {
    test("#then one marker-bearing user message is appended", async () => {
      // given
      const body = chatBody([{ role: "user", content: "You MUST summarize the session" }])
      const step = createCompactionContextStep()
      // when
      const result = await step.run({ body, shape: "chat", sessionID: "ses_c" })
      // then
      expect(result).toEqual({ injected: true, shape: "chat", sessionID: "ses_c" })
      expect(body.messages).toHaveLength(2)
      expect(body.messages[1].content).toContain(COMPACTION_CONTEXT_MARKER)
    })

    test("#then a second run is idempotent", async () => {
      // given
      const body = chatBody([{ role: "user", content: "You MUST summarize the session" }])
      const step = createCompactionContextStep()
      await step.run({ body, kind: "compaction", shape: "chat", sessionID: "ses_c" })
      const afterFirst = body.messages.length
      // when
      const second = await step.run({ body, kind: "compaction", shape: "chat", sessionID: "ses_c" })
      // then
      expect(second).toBeUndefined()
      expect(body.messages).toHaveLength(afterFirst)
    })
  })

  describe("#when a responses compaction request is injected", () => {
    test("#then an input_text user item is appended", async () => {
      // given
      const body = responsesBody([
        { type: "message", role: "user", content: [{ type: "input_text", text: "You MUST summarize" }] },
      ])
      const step = createCompactionContextStep()
      // when
      const result = await step.run({ body, shape: "responses", sessionID: "ses_r" })
      // then
      expect(result).toEqual({ injected: true, shape: "responses", sessionID: "ses_r" })
      expect(body.input).toHaveLength(2)
      expect(body.input[1].role).toBe("user")
      expect(body.input[1].content[0].type).toBe("input_text")
      expect(body.input[1].content[0].text).toContain(COMPACTION_CONTEXT_MARKER)
    })

    test("#then a second run is idempotent", async () => {
      // given
      const body = responsesBody([
        { type: "message", role: "user", content: [{ type: "input_text", text: "You MUST summarize" }] },
      ])
      const step = createCompactionContextStep()
      await step.run({ body, kind: "compaction", shape: "responses" })
      const afterFirst = body.input.length
      // when
      const second = await step.run({ body, kind: "compaction", shape: "responses" })
      // then
      expect(second).toBeUndefined()
      expect(body.input).toHaveLength(afterFirst)
    })
  })

  describe("#when the request is not a compaction", () => {
    test("#then the chat body is left untouched", async () => {
      // given
      const body = chatBody([{ role: "user", content: "hello there" }])
      const step = createCompactionContextStep()
      // when
      const result = await step.run({ body, shape: "chat", sessionID: "ses_plain" })
      // then
      expect(result).toBeUndefined()
      expect(body.messages).toEqual([{ role: "user", content: "hello there" }])
    })

    test("#then a missing kind with non-matching heuristics leaves the responses body untouched", async () => {
      // given
      const body = responsesBody([
        { type: "message", role: "user", content: [{ type: "input_text", text: "nothing to see here" }] },
      ])
      const step = createCompactionContextStep()
      // when
      const result = await step.run({ body, shape: "responses" })
      // then
      expect(result).toBeUndefined()
      expect(body.input).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// 6. Redundant restoration trigger (event-stream independent)
// ---------------------------------------------------------------------------

describe("#given the redundant restoration trigger", () => {
  describe("#when the request carries the compaction kind", () => {
    test("#then it marks restoration once", () => {
      // given
      const marks = []
      const body = { messages: [{ role: "user", content: "unrelated" }] }
      // when
      const result = noteCompactionRestoration({ body, kind: "compaction", mark: () => marks.push(1) })
      // then
      expect(result).toBe(true)
      expect(marks).toHaveLength(1)
    })
  })

  describe("#when the body carries a summary prefix and no kind", () => {
    test("#then the heuristic still marks restoration", () => {
      // given: one case per V1 summary prefix, on both provider shapes
      const cases = [
        { body: { messages: [{ role: "user", content: "You MUST summarize this conversation." }] } },
        { body: { messages: [{ role: "user", content: "Update the existing checkpoint now." }] } },
        { body: { messages: [{ role: "user", content: "The previous response did not fill every field." }] } },
        { body: { input: [{ role: "user", content: [{ type: "input_text", text: "You MUST summarize this conversation." }] }] } },
      ]
      // when / then
      for (const item of cases) {
        const marks = []
        expect(noteCompactionRestoration({ ...item, mark: () => marks.push(1) })).toBe(true)
        expect(marks).toHaveLength(1)
      }
    })
  })

  describe("#when the request is not a compaction summary", () => {
    test("#then nothing is marked", () => {
      // given
      const cases = [
        { body: { messages: [{ role: "system", content: "You are a title generator" }, { role: "user", content: "Prepare to compact." }] } },
        { body: { messages: [{ role: "user", content: "<rigel-native-child-task> plain child" }] } },
        { body: { messages: [{ role: "user", content: "Continue the work." }] } },
        { body: { input: "plain string" } },
        {},
      ]
      // when / then
      for (const item of cases) {
        const marks = []
        expect(noteCompactionRestoration({ ...item, mark: () => marks.push(1) })).toBe(false)
        expect(marks).toHaveLength(0)
      }
    })
  })

  describe("#when no mark reader is provided", () => {
    test("#then it only reports the decision", () => {
      // given
      const body = { messages: [{ role: "user", content: "You MUST summarize this conversation." }] }
      // when / then
      expect(noteCompactionRestoration({ body })).toBe(true)
      expect(noteCompactionRestoration({ body: {} })).toBe(false)
    })
  })
})
