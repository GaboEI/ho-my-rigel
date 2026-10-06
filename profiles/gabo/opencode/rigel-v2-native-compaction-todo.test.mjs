/**
 * Hermetic tests for the Rigel native V2 compaction session-todo injection.
 *
 * The compaction-context hook already carries delegated-session history. This
 * suite pins the todo addition on the same block: incomplete todos survive
 * compaction, finished work does not, the marker makes the injection idempotent,
 * and an absent todo reader leaves the block unchanged instead of throwing.
 *
 * Exercised at the real boundary the runtime consumes: `buildCompactionContextBlock`
 * (block shape) and `createNativeCompactionContextHook` (the A1 messages hook the
 * V2 `compaction` handler calls).
 */

import { describe, expect, test } from "bun:test"

import {
  COMPACTION_CONTEXT_PROMPT,
  SESSION_TODOS_MARKER,
  buildCompactionContextBlock,
  createNativeCompactionContextHook,
  formatIncompleteTodos,
} from "./rigel-v2-native-compaction-context.mjs"

function todo(id, status, content, extra = {}) {
  return { id, content, status, priority: "medium", ...extra }
}

function injectedText(event) {
  return event.messages[0].content[0].text
}

// ---------------------------------------------------------------------------
// 1. formatIncompleteTodos
// ---------------------------------------------------------------------------

describe("#given the incomplete-todo formatter", () => {
  describe("#when the list mixes finished and unfinished todos", () => {
    test("#then only pending and in_progress entries are formatted", () => {
      // given
      const todos = [
        todo("a", "completed", "Already done"),
        todo("b", "in_progress", "Still hacking"),
        todo("c", "cancelled", "Dropped work"),
        todo("d", "pending", "Not started"),
      ]
      // when
      const section = formatIncompleteTodos(todos)
      // then
      expect(section).toContain(SESSION_TODOS_MARKER)
      expect(section).toContain("[in_progress]")
      expect(section).toContain("Still hacking")
      expect(section).toContain("[pending]")
      expect(section).toContain("Not started")
      expect(section).not.toContain("Already done")
      expect(section).not.toContain("Dropped work")
    })
  })

  describe("#when there is nothing incomplete to carry", () => {
    test("#then it returns null for every empty shape", () => {
      // given / when / then
      expect(formatIncompleteTodos([])).toBeNull()
      expect(formatIncompleteTodos(undefined)).toBeNull()
      expect(formatIncompleteTodos(null)).toBeNull()
      expect(formatIncompleteTodos("not-an-array")).toBeNull()
      expect(formatIncompleteTodos([todo("a", "completed", "Done"), todo("b", "cancelled", "Nope")])).toBeNull()
    })
  })

  describe("#when a todo has no id", () => {
    test("#then the line omits the id and keeps status plus content", () => {
      // given
      const todos = [{ content: "No identifier here", status: "pending" }]
      // when
      const section = formatIncompleteTodos(todos)
      // then
      expect(section).toContain("[pending] No identifier here")
      expect(section).not.toContain("(id:")
    })
  })

  describe("#when a todo carries multi-line content", () => {
    test("#then the content collapses to a single line", () => {
      // given
      const todos = [todo("a", "pending", "Line one\n line two\tline three")]
      // when
      const section = formatIncompleteTodos(todos)
      // then
      const bullet = section.split("\n").find((line) => line.startsWith("- ["))
      expect(bullet).toBe("- [pending] (id: `a`) Line one line two line three")
    })
  })
})

// ---------------------------------------------------------------------------
// 2. buildCompactionContextBlock
// ---------------------------------------------------------------------------

describe("#given the compaction context block builder", () => {
  describe("#when incomplete todos are supplied", () => {
    test("#then it appends the Session Todos section with the directive marker", () => {
      // given
      const todos = [todo("keep-1", "in_progress", "Finish the todo continuity work")]
      // when
      const block = buildCompactionContextBlock({ todos })
      // then
      expect(block.startsWith(COMPACTION_CONTEXT_PROMPT)).toBe(true)
      expect(block).toContain("### Session Todos")
      expect(block).toContain(SESSION_TODOS_MARKER)
      expect(block).toContain("Finish the todo continuity work")
      expect(block).toContain("[in_progress]")
    })

    test("#then no completed todo leaks into the block", () => {
      // given
      const todos = [todo("done-1", "completed", "Shipped earlier"), todo("keep-1", "pending", "Remaining work")]
      // when
      const block = buildCompactionContextBlock({ todos })
      // then
      expect(block).toContain("Remaining work")
      expect(block).not.toContain("Shipped earlier")
    })
  })

  describe("#when no todos are supplied", () => {
    test("#then the block is the untouched template (V1 byte parity)", () => {
      // given / when / then
      expect(buildCompactionContextBlock()).toBe(COMPACTION_CONTEXT_PROMPT)
      expect(buildCompactionContextBlock({ todos: [] })).toBe(COMPACTION_CONTEXT_PROMPT)
      expect(buildCompactionContextBlock({ todos: [todo("a", "completed", "Done")] })).toBe(COMPACTION_CONTEXT_PROMPT)
      expect(buildCompactionContextBlock({ todos: undefined })).toBe(COMPACTION_CONTEXT_PROMPT)
    })
  })

  describe("#when both history and todos are supplied", () => {
    test("#then both sections ride on the one block", () => {
      // given
      const history = "- **explore** (running) task_id: `t1`"
      const todos = [todo("keep-1", "pending", "Remaining work")]
      // when
      const block = buildCompactionContextBlock({ history, todos })
      // then
      expect(block).toContain("### Active/Recent Delegated Sessions")
      expect(block).toContain("### Session Todos")
    })
  })
})

// ---------------------------------------------------------------------------
// 3. A1 messages hook
// ---------------------------------------------------------------------------

describe("#given the native compaction-context hook with a todo reader", () => {
  describe("#when the reader returns incomplete todos", () => {
    test("#then the injected block carries them and the reader saw the session id", async () => {
      // given
      const seen = []
      const hook = createNativeCompactionContextHook({
        getTodos: async (sessionID) => {
          seen.push(sessionID)
          return [todo("keep-1", "in_progress", "Carry me across compaction"), todo("done-1", "completed", "Forget me")]
        },
      })
      const event = { sessionID: "ses_parent", messages: [] }
      // when
      await hook(event)
      // then
      expect(seen).toEqual(["ses_parent"])
      const text = injectedText(event)
      expect(text).toContain(SESSION_TODOS_MARKER)
      expect(text).toContain("Carry me across compaction")
      expect(text).not.toContain("Forget me")
    })

    test("#then the hook awaits a synchronous reader that returns a promise", async () => {
      // given: the wiring's async getTodos shape, awaited by the hook
      const hook = createNativeCompactionContextHook({
        getTodos: (sessionID) => Promise.resolve([todo("keep-1", "pending", `todo for ${sessionID}`)]),
      })
      const event = { sessionID: "ses_promise", messages: [] }
      // when
      await hook(event)
      // then
      expect(injectedText(event)).toContain("todo for ses_promise")
    })
  })

  describe("#when the hook runs twice on the same messages array", () => {
    test("#then the marker keeps the injection idempotent", async () => {
      // given
      const hook = createNativeCompactionContextHook({
        getTodos: () => [todo("keep-1", "pending", "Remaining work")],
      })
      const event = { sessionID: "ses_idem", messages: [] }
      // when
      await hook(event)
      const afterFirst = event.messages.length
      await hook(event)
      // then
      expect(afterFirst).toBe(1)
      expect(event.messages).toHaveLength(1)
      const marked = event.messages.filter(
        (message) => Array.isArray(message.content) && message.content.some((part) => part?.text?.includes(SESSION_TODOS_MARKER)),
      )
      expect(marked).toHaveLength(1)
    })
  })

  describe("#when no todo reader is wired", () => {
    test("#then the hook still injects the prompt without a todo section", async () => {
      // given
      const hook = createNativeCompactionContextHook()
      const event = { sessionID: "ses_no_reader", messages: [] }
      // when
      await hook(event)
      // then
      expect(event.messages).toHaveLength(1)
      expect(injectedText(event)).toContain(COMPACTION_CONTEXT_PROMPT)
      expect(injectedText(event)).not.toContain(SESSION_TODOS_MARKER)
    })
  })

  describe("#when the reader yields no incomplete todos", () => {
    test("#then the block stays prompt-only for empty, undefined, and null results", async () => {
      // given
      for (const result of [[], undefined, null, [todo("done-1", "completed", "Done")]]) {
        const hook = createNativeCompactionContextHook({ getTodos: () => result })
        const event = { sessionID: "ses_empty", messages: [] }
        // when
        await hook(event)
        // then
        expect(injectedText(event)).toBe(COMPACTION_CONTEXT_PROMPT)
      }
    })
  })
})
