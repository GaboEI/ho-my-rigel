#!/usr/bin/env node
/**
 * Materializes OmO's V1-generated agents as OpenCode V2 static agent config.
 * It never edits OpenCode configuration; callers choose an output path.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import legacyModule from "../../dist/index.js"

const args = process.argv.slice(2)
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const inputPath = take("--input")
const outputPath = take("--output")
const directory = take("--directory") || process.cwd()
if (!inputPath || !outputPath) {
  console.error("Usage: OMO_PROFILE=gabo node generate-v2-agents.mjs --input <opencode.json> --output <rigel-agents.json> [--directory <cwd>]")
  process.exit(2)
}
const config = JSON.parse(fs.readFileSync(inputPath, "utf8"))
const client = { app: { log: async () => undefined }, session: { messages: async () => ({ data: [] }) } }
const hooks = await legacyModule.server({ directory, client, serverUrl: new URL("http://127.0.0.1:4096") }, {})
try {
  await hooks.config(config)
  const agents = config.agent || {}
  const materialized = {
    "$schema": "https://opencode.ai/config.json",
    "default_agent": config.default_agent,
    "agent": agents,
    "_rigel": {
      "generatedBy": "Ho My Rigel V2 migration",
      "profile": process.env.OMO_PROFILE || null,
      "agentIds": Object.keys(agents),
    },
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(materialized, null, 2) + "\n")
  console.log(JSON.stringify({ defaultAgent: materialized.default_agent, agentCount: Object.keys(agents).length, output: path.resolve(outputPath) }))
} finally {
  await hooks.dispose?.()
}
