import { test, expect } from "bun:test"
import {
  GPT_APPLY_PATCH_GUIDANCE,
  GPT_EDIT_GUIDANCE_MARKER,
  GPT_FILE_EDIT_GUIDANCE,
  gptEditGuidanceBlock,
  gptEditGuidanceForModel,
  isGptFamilyModel,
} from "./rigel-v2-native-gpt-edit-guidance.mjs"

// The two constants are the V1 prompt bytes injected into a GPT model's system
// prompt. Byte parity with V1 `gpt-apply-patch-guard.ts` is the port contract.
test("the guidance constants are byte-identical to V1", () => {
  expect(GPT_APPLY_PATCH_GUIDANCE).toBe(
    "Use `apply_patch` for file edits. Keep patches small and match the surrounding lines exactly so verification passes.",
  )
  expect(GPT_FILE_EDIT_GUIDANCE).toBe(
    "Use whichever file-editing tool is exposed in your toolset (`apply_patch`, or `edit`/`write`). Keep each change small and match the surrounding lines exactly so it applies on the first attempt.",
  )
})

test("#given a GPT model and an apply_patch harness #when guidance is selected #then the apply-patch string is returned", () => {
  expect(gptEditGuidanceForModel("gpt-5.6-sol", { hasApplyPatchTool: true })).toBe(GPT_APPLY_PATCH_GUIDANCE)
})

test("#given a GPT model and no apply_patch tool #when guidance is selected #then the generic string is returned", () => {
  expect(gptEditGuidanceForModel("gpt-5.6-sol")).toBe(GPT_FILE_EDIT_GUIDANCE)
  expect(gptEditGuidanceForModel("gpt-5.6-sol", { hasApplyPatchTool: false })).toBe(GPT_FILE_EDIT_GUIDANCE)
})

test("#given a non-GPT model #when guidance is selected #then undefined is returned regardless of the apply_patch flag", () => {
  expect(gptEditGuidanceForModel("claude-opus-4-5")).toBeUndefined()
  expect(gptEditGuidanceForModel("claude-opus-4-5", { hasApplyPatchTool: true })).toBeUndefined()
  expect(gptEditGuidanceForModel("kimi-k2")).toBeUndefined()
})

test("#given a GPT-family model #when the family is tested #then each of gpt-/codex/o1/o3/o4 matches", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.4", "gpt-6-astra", "gpt-6-luna-fast", "gpt-5-codex", "codex-mini-latest", "o1", "o1-mini", "o3-high", "o4-mini"]) {
    expect(isGptFamilyModel(model)).toBe(true)
  }
})

test("#given a non-GPT model #when the family is tested #then it is not GPT-family", () => {
  for (const model of ["claude-opus-4-5", "kimi-k3", "glm-5.2", "gemini-3.1-pro", "minimax-m3", "big-pickle", "o2-mini", "go4", "opus"]) {
    expect(isGptFamilyModel(model)).toBe(false)
  }
})

test("#given an upper-cased or provider-prefixed id #when the family is tested #then matching stays case- and provider-independent", () => {
  expect(isGptFamilyModel("GPT-5.6-SOL")).toBe(true)
  expect(isGptFamilyModel("O1-Mini")).toBe(true)
  expect(isGptFamilyModel("Codex-Mini")).toBe(true)
  expect(isGptFamilyModel("openai/gpt-4o")).toBe(true)
  expect(isGptFamilyModel("anthropic/CLAUDE-OPUS-4-5")).toBe(false)
})

test("#given an empty, undefined or non-string id #when the family and guidance are resolved #then the result is falsy/undefined", () => {
  expect(isGptFamilyModel("")).toBe(false)
  expect(isGptFamilyModel(undefined)).toBe(false)
  expect(isGptFamilyModel(null)).toBe(false)
  expect(gptEditGuidanceForModel("")).toBeUndefined()
  expect(gptEditGuidanceForModel(undefined)).toBeUndefined()
  expect(gptEditGuidanceForModel(null)).toBeUndefined()
})

test("#given a GPT model #when the injection block is built #then it is marker-delimited and carries the selected guidance", () => {
  const block = gptEditGuidanceBlock("gpt-5.6-sol")
  expect(block.startsWith(GPT_EDIT_GUIDANCE_MARKER)).toBe(true)
  expect(block.endsWith(GPT_EDIT_GUIDANCE_MARKER)).toBe(true)
  expect(block).toContain(GPT_FILE_EDIT_GUIDANCE)
  expect(gptEditGuidanceBlock("gpt-5.6-sol", { hasApplyPatchTool: true })).toContain(GPT_APPLY_PATCH_GUIDANCE)
})

test("#given a non-GPT model #when the injection block is built #then it is empty", () => {
  expect(gptEditGuidanceBlock("claude-opus-4-5")).toBe("")
  expect(gptEditGuidanceBlock("")).toBe("")
})
