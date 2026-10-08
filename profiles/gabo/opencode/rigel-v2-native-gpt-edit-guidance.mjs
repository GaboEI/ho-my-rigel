/**
 * Native V2 port of V1 `packages/omo-opencode/src/agents/gpt-apply-patch-guard.ts`.
 *
 * V1 baked one of two file-edit guidance strings into a GPT agent's prompt at
 * build time: the `apply_patch` string when the harness edited files through
 * `apply_patch`, the generic string when it exposed a different editing tool.
 * V2 exposes the runtime model on the `context` hook (`event.model.modelID`) and
 * lets the hook mutate `event.system`, so the same choice is made per request
 * instead of per baked body.
 *
 * This module is pure: no imports, no state, no I/O. It keys the guidance on the
 * bare model name (the last `/` segment, provider-independent, mirroring
 * `extractModelName` in `rigel-v2-native-sisyphus-prompt.mjs`) and on whether
 * the live harness exposes an `apply_patch` tool. The caller owns that fact: the
 * native V2 runtime registers `edit`/`write`, not `apply_patch`, so it passes
 * `hasApplyPatchTool: false` (the default) and every GPT model receives the
 * generic string; the apply-patch branch stays reachable for a harness that does
 * expose the tool.
 */

/** V1 `GPT_APPLY_PATCH_GUIDANCE`, byte-identical. */
export const GPT_APPLY_PATCH_GUIDANCE =
  "Use `apply_patch` for file edits. Keep patches small and match the surrounding lines exactly so verification passes."

/** V1 `GPT_FILE_EDIT_GUIDANCE`, byte-identical. */
export const GPT_FILE_EDIT_GUIDANCE =
  "Use whichever file-editing tool is exposed in your toolset (`apply_patch`, or `edit`/`write`). Keep each change small and match the surrounding lines exactly so it applies on the first attempt."

/**
 * Sentinel for the injected guidance block, so a repeated context pass rebuilds
 * the block instead of accumulating it (registered alongside the roster,
 * ultrawork, update and directory-instruction markers).
 */
export const GPT_EDIT_GUIDANCE_MARKER = "<rigel-native-gpt-edit-guidance>"

/**
 * Bare, provider-independent model name: the last `/` segment, lowercased.
 * Mirrors `extractModelName` in `rigel-v2-native-sisyphus-prompt.mjs`.
 */
function bareModelName(modelID) {
  const raw = String(modelID ?? "").trim()
  if (!raw) return ""
  const slash = raw.lastIndexOf("/")
  return (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase()
}

// Exact GPT-family rule, applied to the lowercased bare name:
//   - the substring `gpt-` (the OpenAI GPT family: `gpt-5.6-sol`,
//     `openai/gpt-4o`, `chatgpt-4o`), OR
//   - the substring `codex` (the OpenAI codex family: `gpt-5-codex`,
//     `codex-mini-latest`), OR
//   - the token `o1`, `o3`, or `o4` delimited by a non-alphanumeric character or
//     the end of the string (so `o1`, `o1-mini`, `o3-high`, `o4` match, while
//     `o2`, `go4`, and `opus` do not).
const GPT_FAMILY_PATTERN = /gpt-|codex|(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9])/

/**
 * True when `modelID` names a GPT-family model. A provider-prefixed id is
 * reduced to its bare segment first; a missing or empty id is not GPT-family.
 */
export function isGptFamilyModel(modelID) {
  const bare = bareModelName(modelID)
  return bare !== "" && GPT_FAMILY_PATTERN.test(bare)
}

/**
 * File-edit guidance for the runtime model.
 *
 * Returns `GPT_APPLY_PATCH_GUIDANCE` for a GPT-family model when the harness
 * exposes an `apply_patch` tool, `GPT_FILE_EDIT_GUIDANCE` for a GPT-family model
 * without one, and `undefined` for a non-GPT model (no guidance applies).
 */
export function gptEditGuidanceForModel(modelID, { hasApplyPatchTool = false } = {}) {
  if (!isGptFamilyModel(modelID)) return undefined
  return hasApplyPatchTool === true ? GPT_APPLY_PATCH_GUIDANCE : GPT_FILE_EDIT_GUIDANCE
}

/**
 * Marker-wrapped guidance block for idempotent injection into `event.system`,
 * or `""` when the model is not GPT-family. The block is delimited by
 * `GPT_EDIT_GUIDANCE_MARKER` so the runtime's marker strip (which cuts from the
 * first known marker to the end) rebuilds it on a repeated pass instead of
 * appending a second copy.
 */
export function gptEditGuidanceBlock(modelID, options) {
  const guidance = gptEditGuidanceForModel(modelID, options)
  if (!guidance) return ""
  return `${GPT_EDIT_GUIDANCE_MARKER}\n${guidance}\n${GPT_EDIT_GUIDANCE_MARKER}`
}
