/**
 * Native V2 tmux visualization: environment eligibility (rewrite of V1
 * `features/tmux-subagent/environment-eligibility.ts` + `tmux-core/environment`).
 *
 * Observable contract:
 * - `tmuxPath`: the tmux executable resolved on PATH (null when absent).
 * - `insideTmux`: the process runs inside a real tmux server (`TMUX` set).
 * - `sourcePaneId`: the current pane (`TMUX_PANE`), required to split from.
 * - `cmux`: a cmux tmux-compat environment (`CMUX_SOCKET_PATH` set).
 * - `degradedReason`: when the visualization cannot run, the exact reason.
 *   Degraded is an explicit, logged state, never a silent failure.
 */

import fs from "node:fs"

function defaultIsFile(candidate) {
  try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile() } catch { return false }
}

function defaultIsExecutable(candidate, platform) {
  if (platform === "win32") return true
  try { fs.accessSync(candidate, fs.constants.X_OK); return true } catch { return false }
}

export function findExecutableOnPath({ command, env = {}, platform = process.platform, isFile, isExecutable } = {}) {
  if (typeof command !== "string" || !command) return null
  const fileProbe = isFile ?? defaultIsFile
  const execProbe = isExecutable ?? ((candidate) => defaultIsExecutable(candidate, platform))
  const pathValue = env.PATH ?? env.Path ?? ""
  if (typeof pathValue !== "string" || !pathValue) return null
  const separator = platform === "win32" ? ";" : ":"
  const candidates = [command]
  if (platform === "win32" && !/\.[a-zA-Z0-9]+$/.test(command)) {
    const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim()).filter(Boolean)
    for (const ext of pathext) candidates.push(`${command}${ext.toLowerCase()}`, `${command}${ext.toUpperCase()}`)
  }
  for (const directory of pathValue.split(separator)) {
    const dir = directory.trim().replace(/^"(.*)"$/, "$1")
    if (!dir) continue
    for (const candidate of candidates) {
      const full = platform === "win32" ? `${dir}\\${candidate}` : `${dir}/${candidate}`
      if (fileProbe(full) && execProbe(full)) return full
    }
  }
  return null
}

export function detectTmuxVizEnvironment({ env = process.env, platform = process.platform, isFile, isExecutable } = {}) {
  const tmuxPath = findExecutableOnPath({ command: "tmux", env, platform, isFile: isFile ?? defaultIsFile, isExecutable: isExecutable ?? ((candidate) => defaultIsExecutable(candidate, platform)) })
  const insideTmux = Boolean(env.TMUX)
  const sourcePaneId = typeof env.TMUX_PANE === "string" && env.TMUX_PANE ? env.TMUX_PANE : null
  const cmux = typeof env.CMUX_SOCKET_PATH === "string" && Boolean(env.CMUX_SOCKET_PATH)
  const paneCompatible = insideTmux || cmux
  let degradedReason = null
  if (!tmuxPath) degradedReason = "tmux binary not found on PATH"
  else if (!paneCompatible) degradedReason = "not inside a tmux or cmux environment"
  else if (!sourcePaneId) degradedReason = "TMUX_PANE is not set: no source pane to split from"
  return { tmuxPath, insideTmux, paneCompatible, cmux, sourcePaneId, degradedReason }
}
