/**
 * Native V2 `experimental.max_tools` trimming (Phase-4 Ola 6; V1 parity:
 * `plugin/tool-registry-trimming.ts`). When the cap is set, the runtime keeps
 * at most `maxTools` tools: the lowest-priority tools are dropped first, in the
 * exact V1 order, then the remaining unclassified names alphabetically. Core
 * names registered before the conditional families count toward the total, so
 * the whole plugin surface stays within the cap, not just one family.
 */

const LOW_PRIORITY_TOOL_ORDER = [
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "interactive_bash",
  "look_at",
  "call_omo_agent",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
  "background_output",
  "background_cancel",
  "edit",
  "glob",
  "grep",
  "skill_mcp",
  "skill",
  "task",
  // Native V2 runtime names (the V1 `task` tool is `rigel_task` here).
  "rigel_task",
  "todowrite",
  "hashline_edit",
  "lsp_rename",
  "lsp_prepare_rename",
  "lsp_find_references",
  "lsp_goto_definition",
  "lsp_symbols",
  "lsp_diagnostics",
]

export function trimToolNamesToCap(candidateNames, maxTools, { existingNames = [] } = {}) {
  const candidates = [...new Set(candidateNames)]
  const existing = [...new Set(existingNames)]
  const total = new Set([...existing, ...candidates])
  if (!Number.isInteger(maxTools) || maxTools < 1 || total.size <= maxTools) {
    return { kept: candidates, removed: [] }
  }
  const allNames = [...total]
  const removable = [
    ...LOW_PRIORITY_TOOL_ORDER.filter((name) => allNames.includes(name)),
    ...allNames.filter((name) => !LOW_PRIORITY_TOOL_ORDER.includes(name)).sort(),
  ]
  const removedSet = new Set()
  let currentCount = total.size
  for (const name of removable) {
    if (currentCount <= maxTools) break
    removedSet.add(name)
    currentCount -= 1
  }
  return {
    kept: candidates.filter((name) => !removedSet.has(name)),
    removed: [...removedSet].sort(),
  }
}
