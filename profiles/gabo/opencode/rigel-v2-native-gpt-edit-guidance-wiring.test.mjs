/**
 * Wiring contract for the native V2 file-edit guidance (V1 `gpt-apply-patch-guard`).
 *
 * The pure selector is owned by `rigel-v2-native-gpt-edit-guidance.test.mjs`.
 * This file guards the real boundary: `createNativeContextHook` must inject the
 * guidance on the system channel for a GPT-family model and must NOT inject it
 * for a non-GPT model, and the injection must stay a single marker-wrapped block
 * across repeated passes.
 */
import { describe, expect, test } from "bun:test"

import { createNativeContextHook } from "./rigel-v2-native-prompt.mjs"
import { GPT_EDIT_GUIDANCE_MARKER, GPT_FILE_EDIT_GUIDANCE } from "./rigel-v2-native-gpt-edit-guidance.mjs"

function buildHook() {
  return createNativeContextHook({
    getDelegationRoster: async () => [{ name: "Explore", mode: "subagent" }],
    categories: [],
  })
}

function buildEvent(modelID) {
  return {
    sessionID: "ses_gpt_guidance",
    agent: "Sisyphus",
    model: { providerID: "openai", modelID },
    system: [{ type: "text", text: "base system" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: {},
    options: {},
  }
}

function guidanceParts(event) {
  return (event.system ?? []).filter((part) => typeof part?.text === "string" && part.text.includes(GPT_EDIT_GUIDANCE_MARKER))
}

describe("#given the native V2 context hook", () => {
  describe("#when the runtime model is a GPT family model", () => {
    test("#then it injects exactly one marker-wrapped file-edit guidance block", async () => {
      const hook = buildHook()
      const event = buildEvent("openai/gpt-5.6-sol")
      await hook(event)
      const parts = guidanceParts(event)
      expect(parts.length).toBe(1)
      expect(parts[0].text).toContain(GPT_FILE_EDIT_GUIDANCE)
    })

    test("#when the hook runs twice #then the guidance stays a single block", async () => {
      const hook = buildHook()
      const event = buildEvent("openai/gpt-5.6-sol")
      await hook(event)
      await hook(event)
      expect(guidanceParts(event).length).toBe(1)
    })
  })

  describe("#when the runtime model is not a GPT family model", () => {
    test("#then it injects no file-edit guidance", async () => {
      const hook = buildHook()
      const event = buildEvent("anthropic/claude-opus-5-5")
      await hook(event)
      expect(guidanceParts(event).length).toBe(0)
    })
  })
})
