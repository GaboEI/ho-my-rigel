#!/usr/bin/env node
/**
 * Materializes selected OmO V1-generated agents as a data-only manifest for
 * the native V2 AgentEditor runtime. It never edits OpenCode configuration.
 */
import fs from "node:fs"
import path from "node:path"
import legacyModule from "../../dist/index.js"

const args = process.argv.slice(2)
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const inputPath = take("--input")
const outputPath = take("--output")
const directory = take("--directory") || process.cwd()
const selectionPath = take("--selection")
const judgePath = take("--judge")
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
  for (const [id, mode] of Object.entries(selection?.nativeAgentModeOverrides ?? {})) {
    if (selected[id] && ["primary", "subagent", "all"].includes(mode)) {
      selected[id] = { ...selected[id], mode }
    }
  }
  const judge = judgePath ? JSON.parse(fs.readFileSync(judgePath, "utf8")) : null
  if (selection?.independentJudge?.id && !judge) throw new Error("Rigel Judge definition is required")
  if (judge) selected[selection?.independentJudge?.id ?? "judge"] = judge
  const materialized = {
    defaultAgent: config.default_agent,
    agents: selected,
    metadata: {
      generatedBy: "Ho My Rigel V2 native runtime",
      profile: process.env.OMO_PROFILE || null,
      global: {
        tools: { ...(config.tools ?? {}) },
        permission: { ...(config.permission ?? {}) },
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
