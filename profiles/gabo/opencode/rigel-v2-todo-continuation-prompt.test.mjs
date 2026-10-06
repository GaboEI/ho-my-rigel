/**
 * RED parity tests for the V2 todo-continuation prompt port.
 *
 * The port must expose the exact V1 continuation prompt (byte-for-byte, so the
 * system-directive sentinel the runtime filters on survives), the directive
 * marker, and a builder that carries the status line and every todo item into
 * the prompt. The V2 module does not exist yet, so every test here is RED until
 * it lands.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  CONTINUATION_PROMPT,
  CONTINUATION_PROMPT_MARKER,
  buildContinuationPrompt,
} from "./rigel-v2-todo-continuation-prompt.mjs"
import { CONTINUATION_PROMPT as V1_CONTINUATION_PROMPT } from "../../../packages/omo-opencode/src/hooks/todo-continuation-enforcer/constants.ts"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DIRECTIVE_SOURCE = join(REPO_ROOT, "packages", "omo-opencode", "src", "shared", "system-directive.ts")

function v1TodoContinuationMarker() {
  const source = readFileSync(DIRECTIVE_SOURCE, "utf8")
  const prefix = /export const SYSTEM_DIRECTIVE_PREFIX = "([^"]+)"/.exec(source)
  const type = /TODO_CONTINUATION:\s*"([^"]+)"/.exec(source)
  if (!prefix || !type) throw new Error("could not parse the V1 system directive constants")
  return `${prefix[1]} - ${type[1]}]`
}

function incompleteTodo(content, status) {
  return { content, status, priority: "high" }
}

describe("#given the V2 todo-continuation prompt port", () => {
  describe("#when the V1 constant is imported at test time", () => {
    test("#then CONTINUATION_PROMPT is byte-identical to the V1 prompt", () => {
      // given / when / then
      expect(CONTINUATION_PROMPT).toBe(V1_CONTINUATION_PROMPT)
    })

    test("#then CONTINUATION_PROMPT_MARKER is the V1 system directive and the prompt starts with it", () => {
      // given
      const expectedMarker = v1TodoContinuationMarker()
      // when / then
      expect(typeof CONTINUATION_PROMPT_MARKER).toBe("string")
      expect(CONTINUATION_PROMPT_MARKER.length).toBeGreaterThan(0)
      expect(CONTINUATION_PROMPT_MARKER).toBe(expectedMarker)
      expect(CONTINUATION_PROMPT.startsWith(CONTINUATION_PROMPT_MARKER)).toBe(true)
    })
  })
})

describe("#given the continuation prompt builder", () => {
  describe("#when incomplete todos and a count are supplied", () => {
    test("#then the marker, the status line, and every todo item are present", () => {
      // given
      const todos = [
        incompleteTodo("Fix the parser", "in_progress"),
        incompleteTodo("Ship the fix", "pending"),
      ]
      // when
      const prompt = buildContinuationPrompt({ todos, incompleteCount: 2 })
      // then
      expect(typeof prompt).toBe("string")
      expect(prompt).toContain(CONTINUATION_PROMPT)
      expect(prompt).toContain(CONTINUATION_PROMPT_MARKER)
      expect(prompt).toContain("[Status:")
      expect(prompt).toContain("2 remaining")
      for (const todo of todos) {
        expect(prompt).toContain(todo.content)
      }
    })
  })

  describe("#when the todo list is empty", () => {
    test("#then the base prompt and a zero status line are returned", () => {
      // given / when
      const prompt = buildContinuationPrompt({ todos: [], incompleteCount: 0 })
      // then
      expect(prompt).toContain(CONTINUATION_PROMPT)
      expect(prompt).toContain("0 remaining")
    })
  })
})
