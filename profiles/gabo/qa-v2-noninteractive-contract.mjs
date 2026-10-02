#!/usr/bin/env node
/** Proves V2's real builtin shell call is rewritten by the native Rigel guard. */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261002-rigel-v2-noninteractive-contract")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-noninteractive-"))
const providerPort = 41245
const traceFile = path.join(temporary, "provider-trace.jsonl")
const hookTrace = path.join(temporary, "hook-trace.json")
let provider

function save(name, value) { fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 }) }

try {
  const configHome = path.join(temporary, "config")
  const home = path.join(temporary, "home")
  const plugin = path.join(temporary, "plugin")
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native-noninteractive.mjs"), path.join(plugin, "guard.mjs"))
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  fs.writeFileSync(path.join(plugin, "index.js"), `
import fs from "node:fs"
import { createNativeNonInteractiveEnvGuard } from "./guard.mjs"
export default { id: "rigel-v2-noninteractive-contract", setup: async (context) => {
  const guard = createNativeNonInteractiveEnvGuard()
  await context.tool.hook("execute.before", async (event) => {
    guard.before(event)
    if (event.tool === "shell") fs.writeFileSync(process.env.RIGEL_NONINTERACTIVE_HOOK_TRACE, JSON.stringify(event.input))
  })
} }
`)
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({ provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } }, model: "rigel-fixture/fixture", plugin: [plugin], default_agent: "Sisyphus - ultraworker", agent: { "Sisyphus - ultraworker": { mode: "primary", model: "rigel-fixture/fixture" } } }, null, 2) + "\n")
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temporary, "data"), XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache"), RIGEL_NONINTERACTIVE_HOOK_TRACE: hookTrace }
  const runScenario = (taskArguments, prompt) => {
    provider?.kill("SIGTERM")
    provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "shell", RIGEL_FAKE_TASK_ARGUMENTS: JSON.stringify(taskArguments), RIGEL_FAKE_PARENT_REPLY: "RIGEL_V2_NONINTERACTIVE_OK" }, stdio: "ignore" })
    return childProcess.spawnSync(binary, ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", prompt], { cwd: sourceRoot, env, encoding: "utf8", timeout: 60_000 })
  }
  const observedOf = (result) => {
    const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
    const observed = fs.existsSync(hookTrace) ? fs.readFileSync(hookTrace, "utf8") : ""
    return { transcript, observed }
  }

  // Scenario 1: a git command is rewritten with the non-interactive prefix.
  const first = observedOf(runScenario({ command: "git --version" }, "Run git --version through shell."))
  save("transcript-git-rewrite.txt", first.transcript); save("hook-trace.json", first.observed)
  const rewritten = /GIT_TERMINAL_PROMPT=0/.test(first.observed) && /git --version/.test(first.observed)

  // Scenario 2: a banned interactive command becomes the observable warning.
  const second = observedOf(runScenario({ command: "git rebase -i HEAD~1" }, "Run git rebase -i HEAD~1 through shell."))
  save("transcript-banned-warning.txt", second.transcript); save("hook-trace-banned.json", second.observed)
  const warned = second.observed.includes("echo") && /Warning: 'git rebase -i' is an interactive command that may hang in non-interactive environments\./.test(second.observed) && !second.observed.includes("HEAD~1")

  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
  save("provider-trace.jsonl", trace)
  const report = `# Rigel V2 non-interactive shell contract\n\n- Real isolated V2 process: yes.\n- Builtin shell reached the native pre-hook: ${first.observed ? "yes" : "no"}.\n- Git command was rewritten with non-interactive variables: ${rewritten ? "yes" : "no"}.\n- Banned interactive command became the v1-equivalent warning: ${warned ? "yes" : "no"}.\n`
  save("validation.md", report); process.stdout.write(report)
  if (!rewritten || !warned || !first.transcript.includes("RIGEL_V2_NONINTERACTIVE_OK")) process.exitCode = 1
} finally { provider?.kill("SIGTERM"); fs.rmSync(temporary, { recursive: true, force: true }) }
