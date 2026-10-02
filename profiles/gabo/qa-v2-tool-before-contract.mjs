#!/usr/bin/env node
/** Proves a native V2 execute.before hook can reject a real model tool call. */
import childProcess from "node:child_process"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261002-rigel-v2-tool-before-contract")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-tool-before-"))
const providerPort = 41244
const traceFile = path.join(temporary, "provider-trace.jsonl")
let provider

function save(name, value) { fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 }) }

try {
  const configHome = path.join(temporary, "config")
  const home = path.join(temporary, "home")
  const plugin = path.join(temporary, "plugin")
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  fs.writeFileSync(path.join(plugin, "index.js"), `
export default { id: "rigel-v2-tool-before-contract", setup: async (context) => {
  await context.tool.transform((editor) => editor.add({ name: "marker_tool", options: { codemode: false }, description: "Controlled tool.", input: { type: "object", properties: { deny: { type: "boolean" } }, required: ["deny"], additionalProperties: false }, execute: async () => ({ content: "UNREACHABLE" }) }))
  await context.tool.hook("execute.before", async (event) => { if (event.tool === "marker_tool" && event.input.deny === true) { console.error("[rigel-tool-before-contract] call blocked"); throw new Error("RIGEL_V2_PRE_TOOL_BLOCK") } })
} }
`)
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({ provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } }, model: "rigel-fixture/fixture", plugin: [plugin], default_agent: "Sisyphus - ultraworker", agent: { "Sisyphus - ultraworker": { mode: "primary", model: "rigel-fixture/fixture" } } }, null, 2) + "\n")
  const env = { ...buildIsolatedV2Env({ sandbox: temporary, home: home }) }
  provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "marker_tool", RIGEL_FAKE_TASK_ARGUMENTS: JSON.stringify({ deny: true }), RIGEL_FAKE_PARENT_REPLY: "RIGEL_V2_TOOL_BEFORE_OK" }, stdio: "ignore" })
  const result = childProcess.spawnSync(binary, ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", "Call marker_tool once."], { cwd: sourceRoot, env, encoding: "utf8", timeout: 60_000 })
  const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
  save("transcript.txt", transcript); save("provider-trace.jsonl", trace)
  const blocked = transcript.includes("[rigel-tool-before-contract] call blocked") && trace.includes("RIGEL_V2_PRE_TOOL_BLOCK") && !trace.includes("UNREACHABLE")
  const report = `# Rigel V2 tool.execute.before contract\n\n- Real isolated V2 process: yes.\n- Hook blocked the tool call: ${blocked ? "yes" : "no"}.\n- Tool executor was bypassed: ${!trace.includes("UNREACHABLE") ? "yes" : "no"}.\n`
  save("validation.md", report); process.stdout.write(report)
  if (!blocked || !transcript.includes("RIGEL_V2_TOOL_BEFORE_OK")) process.exitCode = 1
} finally { provider?.kill("SIGTERM"); fs.rmSync(temporary, { recursive: true, force: true }) }
