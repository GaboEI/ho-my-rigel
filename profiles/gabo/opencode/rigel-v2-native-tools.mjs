/**
 * Native OpenCode V2 tool aggregator for Ho My Rigel.
 *
 * F2 (`task-14-17-fase3-herramientas.md`) owns this module: it scans
 * `profiles/gabo/opencode/tools/*.tools.mjs` in sorted order, imports each
 * family, and merges the returned tool records into one map. A family is
 * included only when its gate is enabled, so a disabled feature contributes no
 * tool name to the editor.
 *
 * Task 15 registers three families through this aggregator:
 *   - `session.tools.mjs`  (always on)
 *   - `look-at.tools.mjs`  (always on; the multimodal-looker agent gate is a
 *     separate concern owned by the agent manifest)
 *   - `monitor.tools.mjs`  (gated on `gates.monitor`)
 *
 * The aggregator is deliberately explicit rather than a dynamic `readdir`
 * import: a static import list is auditable, works under Bun's bundler, and
 * cannot silently pick up a stray file. F2 may replace the list with a scan;
 * the merge contract stays the same.
 */

import { createSessionTools } from "./tools/session.tools.mjs"
import { createLookAtTool } from "./tools/look-at.tools.mjs"
import { createMonitorTools } from "./tools/monitor.tools.mjs"
import { createMonitorRegistry } from "./tools/monitor-engine.mjs"
import { readNativeGates } from "./rigel-v2-native-config.mjs"

/**
 * Build every enabled native tool family.
 *
 * @param {object} input
 * @param {object[]} input.clients   ordered V2 client candidates
 * @param {object}   input.location  V2 location
 * @param {object}   input.manifest  materialized agent manifest (gate source)
 * @param {object}   input.context   V2 setup context (pty/storage/event domains)
 * @param {object}   input.pluginConfig  profile config block (monitor settings)
 * @returns {{ tools: Record<string, object>, registry: object|undefined }}
 */
export function createNativeToolFamilies({ clients, location, manifest, context, pluginConfig }) {
  const gates = readNativeGates(manifest)
  const tools = {}

  Object.assign(tools, createSessionTools({ clients, directory: location?.directory }))
  tools.look_at = createLookAtTool({ clients, location })

  let registry
  if (gates.monitor) {
    registry = createMonitorRegistry({
      storage: context?.storage,
      pty: context?.pty,
      event: context?.event,
      sessions: context?.session,
      config: pluginConfig?.monitor ?? {},
    })
    Object.assign(tools, createMonitorTools({ registry, pluginConfig }))
  }

  return { tools, registry }
}

export { readNativeGates }
