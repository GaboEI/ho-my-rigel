#!/usr/bin/env node
/**
 * Materializes selected OmO V1-generated agents as a data-only manifest for
 * the native V2 AgentEditor runtime. It never edits OpenCode configuration.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import legacyModule from "../../dist/index.js"
import { sortAgentsByCanonicalOrder } from "./opencode/rigel-v2-native-agent-order.mjs"
import { deriveNativeGates, deriveNativeMinOpenCodeVersion, resolveNativePluginConfig } from "./opencode/rigel-v2-native-config.mjs"

const args = process.argv.slice(2)
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const inputPath = take("--input")
const outputPath = take("--output")
const directory = take("--directory") || process.cwd()
const selectionPath = take("--selection")
const judgePath = take("--judge")
const profileRoot = take("--profile-root")
// T38: the native runtime registers the retained builtin MCP servers (grep_app,
// lsp) through `context.mcp.transform`. The lsp server command must resolve
// `packages/lsp-daemon` in the source tree, which the deployed runtime (staged
// under the lab state root) cannot discover by walking its own directory, so the
// repo root and the MCP retention policy are materialized into the manifest.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(moduleDirectory, "../..")
const integrationManifest = JSON.parse(fs.readFileSync(path.join(moduleDirectory, "integration-manifest.json"), "utf8"))
const manifestMcpPolicy = integrationManifest?.mcpPolicy ?? {}
if (!inputPath || !outputPath) {
  console.error("Usage: OMO_PROFILE=gabo node generate-v2-agents.mjs --input <opencode.json> --output <rigel-agent-manifest.mjs> --selection <v2-agent-selection.json> --judge <judge.v2.json> [--directory <cwd>]")
  process.exit(2)
}
const config = JSON.parse(fs.readFileSync(inputPath, "utf8"))
const client = { app: { log: async () => undefined }, session: { messages: async () => ({ data: [] }) } }
const hooks = await legacyModule.server({ directory, client, serverUrl: new URL("http://127.0.0.1:4096") }, {})

try {
  await hooks.config(config)
  const allAgents = config.agent || {}
  const selection = selectionPath ? JSON.parse(fs.readFileSync(selectionPath, "utf8")) : null
  const selected = {}
  for (const id of selection?.orchestratedAgentIds ?? Object.keys(allAgents)) {
    if (!allAgents[id]) throw new Error(`OmO did not generate the required agent: ${id}`)
    selected[id] = allAgents[id]
  }
  for (const id of selection?.optionalAgentIds ?? []) {
    if (allAgents[id]) selected[id] = allAgents[id]
  }
  for (const id of selection?.demotedAgentIds ?? []) {
    if (allAgents[id]) selected[id] = allAgents[id]
  }
  for (const [id, mode] of Object.entries(selection?.nativeAgentModeOverrides ?? {})) {
    if (selected[id] && ["primary", "subagent", "all"].includes(mode)) {
      selected[id] = { ...selected[id], mode }
    }
  }
  const judge = judgePath ? JSON.parse(fs.readFileSync(judgePath, "utf8")) : null
  if (selection?.independentJudge?.id && !judge) throw new Error("Rigel Judge definition is required")
  if (judge) selected[selection?.independentJudge?.id ?? "judge"] = judge
  // Task 13 (Oh My Rigel Phase 2 migration): manifest order must be canonical
  // at the source. Core agents come first in Sisyphus -> Hephaestus ->
  // Prometheus -> Atlas order; every other key keeps its insertion order, so
  // the judge stays in the remainder tail. The canonical keys stay owned by
  // the shared order module, not hardcoded here.
  const orderedSelected = {}
  for (const { id } of sortAgentsByCanonicalOrder(Object.keys(selected).map((key) => ({ id: key, name: key })))) {
    orderedSelected[id] = selected[id]
  }
  // The manifest is the materialized artifact: the runtime reads gates and
  // categories from `metadata.global` and never parses `omo.jsonc` itself. The
  // materializer (this generator) owns that parse, using the parity-pinned
  // native resolver rather than the V1 plugin's internal config object.
  // `--profile-root` pins the user layer so resolution never depends on an
  // ambient HOME.
  const pluginView = resolveNativePluginConfig({
    directory,
    ...(profileRoot ? { env: { ...process.env, HOME: profileRoot } } : {}),
  })
  const gates = deriveNativeGates(pluginView)
  // A V1 tool default can carry a hard global disable for a family the native
  // profile explicitly enables (`task_*: false` is the default). The native gate
  // wins: an enabled family must not stay denied by a stale V1 tool default, or
  // the family registers but every call is rejected by the permission gate.
  const tools = { ...(config.tools ?? {}) }
  if (gates.task_system) tools["task_*"] = true
  if (gates.goal) tools["goal_*"] = true
   if (gates.monitor) tools["monitor_*"] = true
   if (gates.team_mode) tools["team_*"] = true
  if (gates.interactive_bash) tools["interactive_bash"] = true
  if (gates.hashline_edit) tools["hashline_edit"] = true
  const materialized = {
    defaultAgent: config.default_agent,
    agents: orderedSelected,
    metadata: {
      generatedBy: "Oh My Rigel V2 native runtime",
      profile: process.env.OMO_PROFILE || null,
      global: {
        tools,
        permission: { ...(config.permission ?? {}) },
        gates,
        maxTools: pluginView.experimental?.max_tools,
        // T34: the Rigel preemptive-compaction threshold override, materialized
        // so the runtime reads it from the manifest instead of parsing omo.jsonc.
        preemptiveCompactionThreshold: pluginView.experimental?.preemptive_compaction_threshold,
        // T38: V1 `experimental.truncate_all_tool_outputs`, materialized so the
        // runtime's tool-output truncator reads it from the manifest.
        truncateAllToolOutputs: pluginView.experimental?.truncate_all_tool_outputs === true,
        mcp: { disabled: [...(pluginView.disabled_mcps ?? [])], envAllowlist: [...(pluginView.mcp_env_allowlist ?? [])] },
        // T38: materialized MCP retention policy + repo root for the native
        // builtin-MCP registration (grep_app remote, lsp local).
        repoRoot: sourceRoot,
        mcpPolicy: {
          retained: [...(manifestMcpPolicy.omoBuiltinsRetained ?? [])],
          builtinsDisabled: [...(manifestMcpPolicy.omoBuiltinsDisabled ?? [])],
        },
        tmuxVisualization: pluginView.team_mode?.tmux_visualization === true,
        // V1 `minimum-opencode-version.ts` refuses an unsupported host. The
        // native runtime enforces the same floor from the materialized minimum
        // (derived from integration-manifest.json platform.opencode), read at
        // setup from `context.app.version`.
        minOpenCodeVersion: deriveNativeMinOpenCodeVersion(integrationManifest),
        categories: { ...(pluginView.categories ?? {}) },
        disabled: { ...(pluginView.disabled ?? {}) },
        // The resolved monitor block (enabled + allowed_commands) is needed by
        // the monitor tools' permission check; the V2 setup context has no
        // `config`, so the manifest is the only honest source.
        monitor: pluginView.monitor,
      },
    },
    modes: { defaultUltrawork: selection?.nativeModes?.defaultUltrawork === true },
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
  fs.writeFileSync(outputPath, `// Generated; do not edit.\nexport default ${JSON.stringify(materialized, null, 2)}\n`)
  console.log(JSON.stringify({ defaultAgent: materialized.defaultAgent, agentCount: Object.keys(selected).length, output: path.resolve(outputPath) }))
} finally {
  await hooks.dispose?.()
}
