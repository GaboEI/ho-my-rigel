#!/usr/bin/env node
/**
 * Establishes whether V2 tool.execute.after can alter the model-visible tool
 * result. Several V1 reminders relied on appending text at this exact point.
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261002-rigel-v2-tool-after-result-contract")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-tool-after-"))
const providerPort = 41242
const traceFile = path.join(temporary, "provider-trace.jsonl")
let provider

function write(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const configHome = path.join(temporary, "config")
  const home = path.join(temporary, "home")
  const plugin = path.join(temporary, "plugin")
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  fs.writeFileSync(path.join(plugin, "index.js"), `
export default {
  id: "rigel-v2-tool-after-result-contract",
  setup: async (context) => {
    await context.tool.transform((editor) => editor.add({
      name: "marker_tool", options: { codemode: false }, description: "Return a controlled result.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: "BASE_TOOL_RESULT" }),
    }))
    await context.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      console.error("[rigel-tool-after-contract] event keys=" + Object.keys(event).sort().join(",") + "; agent=" + String(event.agent))
      try {
        event.result.content = "RIGEL_V2_AFTER_RESULT_MARKER"
        console.error("[rigel-tool-after-contract] result mutation accepted")
      } catch (error) {
        console.error("[rigel-tool-after-contract] result mutation rejected: " + String(error))
      }
    })
  },
}
`)
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } },
    model: "rigel-fixture/fixture", plugin: [plugin], default_agent: "Sisyphus - ultraworker",
    agent: { "Sisyphus - ultraworker": { mode: "primary", model: "rigel-fixture/fixture" } },
  }, null, 2) + "\n")
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temporary, "data"), XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache") }
  provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "marker_tool", RIGEL_FAKE_TASK_ARGUMENTS: "{}", RIGEL_FAKE_PARENT_REPLY: "RIGEL_V2_TOOL_AFTER_OK" }, stdio: "ignore" })
  const result = childProcess.spawnSync(binary, ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", "Call marker_tool exactly once."], { cwd: sourceRoot, env, encoding: "utf8", timeout: 60_000 })
  const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
  write("transcript.txt", transcript)
  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
  write("provider-trace.jsonl", trace)
  const providerSawMutation = trace.includes("RIGEL_V2_AFTER_RESULT_MARKER")
  const report = `# Rigel V2 tool.execute.after result contract\n\n- Real isolated V2 process: yes.\n- Hook accepted a result mutation: ${transcript.includes("result mutation accepted") ? "yes" : "no"}.\n- Provider received the mutated tool result: ${providerSawMutation ? "yes" : "no"}.\n`
  write("validation.md", report)
  process.stdout.write(report)
  if (!providerSawMutation || !transcript.includes("RIGEL_V2_TOOL_AFTER_OK")) process.exitCode = 1
} finally {
  provider?.kill("SIGTERM")
  fs.rmSync(temporary, { recursive: true, force: true })
}
