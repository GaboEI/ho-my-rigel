/**
 * Native V2 tmux visualization: pane state query and parsing (rewrite of V1
 * `features/tmux-subagent/pane-state-querier.ts` + `pane-state-parser.ts`).
 *
 * One `list-panes` call answers the full window state the visualization needs:
 * pane geometry, the active pane, window size, server attachment, and the pane
 * title. The main pane heuristic picks the leftmost (then widest, then
 * topmost, then the source pane itself) pane; every other pane is an agent
 * pane.
 */

export const PANE_STATE_FORMAT = "#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{pane_active}\t#{window_width}\t#{window_height}\t#{window_active}\t#{session_attached}\t#{pane_title}"

const MANDATORY_FIELD_COUNT = 10

function parseInteger(value) {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : null
}

export function parsePaneStateOutput(output) {
  const panes = []
  let windowWidth = null
  let windowHeight = null
  let windowActive = false
  let sessionAttached = false
  for (const rawLine of String(output ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (!line.trim()) continue
    const fields = line.split("\t")
    if (fields.length < MANDATORY_FIELD_COUNT) continue
    const paneId = fields[0]
    const paneWidth = parseInteger(fields[1])
    const paneHeight = parseInteger(fields[2])
    const left = parseInteger(fields[3])
    const top = parseInteger(fields[4])
    if (!paneId || paneWidth === null || paneHeight === null || left === null || top === null) continue
    const paneActive = fields[5] === "1"
    const lineWidth = parseInteger(fields[6])
    const lineHeight = parseInteger(fields[7])
    const lineActive = fields[8] === "1"
    const attached = parseInteger(fields[9]) ?? 0
    if (lineWidth !== null && lineHeight !== null) {
      windowWidth = lineWidth
      windowHeight = lineHeight
      windowActive = lineActive
      sessionAttached = attached > 0
    }
    panes.push({
      paneId,
      width: paneWidth,
      height: paneHeight,
      left,
      top,
      active: paneActive,
      title: fields.slice(MANDATORY_FIELD_COUNT).join("\t"),
    })
  }
  return { panes, windowWidth, windowHeight, windowActive, sessionAttached }
}

export function selectMainPane(panes, sourcePaneId) {
  if (!Array.isArray(panes) || panes.length === 0) return { mainPane: null, agentPanes: [] }
  const sorted = [...panes].sort((a, b) => (a.left - b.left) || (a.top - b.top))
  const mainPane = sorted.reduce((selected, pane) => {
    if (pane.left !== selected.left) return pane.left < selected.left ? pane : selected
    if (pane.width !== selected.width) return pane.width > selected.width ? pane : selected
    if (pane.top !== selected.top) return pane.top < selected.top ? pane : selected
    return pane.paneId === sourcePaneId ? pane : selected
  }, sorted[0])
  return { mainPane, agentPanes: panes.filter((pane) => pane.paneId !== mainPane.paneId) }
}

/**
 * Query the live window state around `sourcePaneId`. Returns null when the
 * tmux command fails or the window has no usable main pane, so callers apply
 * their degraded branch instead of guessing.
 */
export async function queryWindowState({ runner, sourcePaneId }) {
  const result = await runner.run(["list-panes", "-t", sourcePaneId, "-F", PANE_STATE_FORMAT])
  if (result.exitCode !== 0) return null
  const parsed = parsePaneStateOutput(result.stdout)
  if (parsed.panes.length === 0 || parsed.windowWidth === null || parsed.windowHeight === null) return null
  const { mainPane, agentPanes } = selectMainPane(parsed.panes, sourcePaneId)
  if (!mainPane) return null
  return {
    windowWidth: parsed.windowWidth,
    windowHeight: parsed.windowHeight,
    windowActive: parsed.windowActive,
    sessionAttached: parsed.sessionAttached,
    mainPane,
    agentPanes,
  }
}
