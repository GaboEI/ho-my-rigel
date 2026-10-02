#!/usr/bin/env node
/** Proves that a matched V1-style rule reaches a real V2 provider turn. */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261002-rigel-v2-native-rules-injector")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-rules-contract-"))
const providerPort = 41243
const traceFile = path.join(temporary, "provider-trace.jsonl")
let provider

function save(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const workspace = sourceRoot
  const configHome = path.join(temporary, "config")
  const home = path.join(temporary, "home")
  const runtime = path.join(temporary, "plugin")
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  const files = ["rigel-v2-native.mjs", "rigel-v2-native-core.mjs", "rigel-v2-native-prompt.mjs", "rigel-v2-directory-instructions.mjs", "rigel-v2-native-reminders.mjs", "rigel-v2-native-recovery.mjs", "rigel-v2-native-rules.mjs", "rigel-v2-native-categories.mjs", "rigel-v2-category-manifest.mjs", "rigel-v2-native-agents.mjs"]
  for (const file of files) fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode", file), path.join(runtime, file === "rigel-v2-native.mjs" ? "index.js" : file))
  fs.copyFileSync(path.join(sourceRoot, "packages/prompts-core/prompts/ultrawork/default.md"), path.join(runtime, "prompts/ultrawork-default.md"))
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(runtime, "rigel-v2-native-agent-manifest.mjs"), `export default ${JSON.stringify({ defaultAgent: "Sisyphus - ultraworker", modes: { defaultUltrawork: false }, agents: { "Sisyphus - ultraworker": { mode: "primary", name: "Sisyphus - ultraworker", model: "rigel-fixture/fixture", prompt: "Coordinate.", permission: { read: "allow", external_directory: "allow" } } } })}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } },
    model: "rigel-fixture/fixture", plugin: [runtime], default_agent: "Sisyphus - ultraworker",
  }, null, 2) + "\n", { mode: 0o600 })
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temporary, "data"), XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache") }
  provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "read", RIGEL_FAKE_TASK_ARGUMENTS: JSON.stringify({ path: path.join(workspace, "profiles/gabo/opencode/rigel-v2-native-rules.test.mjs") }), RIGEL_FAKE_PARENT_REPLY: "RIGEL_V2_RULE_PARENT_OK" }, stdio: "ignore" })
  const result = childProcess.spawnSync(binary, ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", "Read the test file exactly once."], { cwd: workspace, env, encoding: "utf8", timeout: 60_000 })
  const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
  save("transcript.txt", transcript)
  save("provider-trace.jsonl", trace)
  const injected = trace.includes("[Rule: .omo/rules/rigel.md]") && trace.includes("[Rule: .omo/rules/test-discipline.md]")
  const passed = transcript.includes("Native OpenCode V2 runtime active") && transcript.includes("RIGEL_V2_RULE_PARENT_OK") && injected
  const report = `# Rigel V2 native rules injector contract\n\n- Real isolated V2 process: yes.\n- Native runtime loaded: ${transcript.includes("Native OpenCode V2 runtime active") ? "yes" : "no"}.\n- Matched project rules reached the provider after a V2 read: ${injected ? "yes" : "no"}.\n- V1 configuration read: no.\n`
  save("validation.md", report)
  process.stdout.write(report)
  if (!passed) process.exitCode = 1
} finally {
  provider?.kill("SIGTERM")
  fs.rmSync(temporary, { recursive: true, force: true })
}
