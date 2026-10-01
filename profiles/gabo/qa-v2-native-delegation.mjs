#!/usr/bin/env node
/** Proves Rigel's native V2 named delegation in a disposable XDG sandbox. */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = "/home/gabodev/.opencode/bin/opencode"
const liveConfig = "/home/gabodev/.config/opencode/opencode.json"
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261001-rigel-v2-native-delegation")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-native-v2-"))
const configHome = path.join(temporary, "config")
const home = path.join(temporary, "home")
const runtime = path.join(temporary, "plugin")
const category = process.env.RIGEL_NATIVE_TEST_CATEGORY
const nativeTaskName = "rigel_v2_task"

function writeEvidence(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const live = JSON.parse(fs.readFileSync(liveConfig, "utf8"))
  const agent = live.agent?.["Sisyphus - ultraworker"]
  if (!agent) throw new Error("No se encontró Sisyphus - ultraworker en la configuración activa")
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native.mjs"), path.join(runtime, "index.js"))
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native-core.mjs"), path.join(runtime, "rigel-v2-native-core.mjs"))
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native-prompt.mjs"), path.join(runtime, "rigel-v2-native-prompt.mjs"))
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native-categories.mjs"), path.join(runtime, "rigel-v2-native-categories.mjs"))
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-category-manifest.mjs"), path.join(runtime, "rigel-v2-category-manifest.mjs"))
  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(sourceRoot, "packages/prompts-core/prompts/ultrawork/default.md"), path.join(runtime, "prompts/ultrawork-default.md"))
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    model: live.model,
    small_model: live.small_model,
    provider: live.provider,
    plugins: live.plugins,
    plugin: [runtime],
    tools: { subagent: false },
    default_agent: "Sisyphus - ultraworker",
    agent: live.agent,
  }, null, 2) + "\n", { mode: 0o600 })
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(temporary, "data"),
    XDG_STATE_HOME: path.join(temporary, "state"),
    XDG_CACHE_HOME: path.join(temporary, "cache"),
    RIGEL_NATIVE_DEFAULT_ULTRAWORK: "0",
    RIGEL_NATIVE_TASK_NAME: nativeTaskName,
  }
  const prompt = category
    ? `Use the tool named ${nativeTaskName} exactly once. Delegate through category ${category}: list only the root files and directories of this repository, without editing anything. After the tool returns successfully, reply exactly RIGEL_NATIVE_V2_TASK_OK.`
    : `Use the tool named ${nativeTaskName} exactly once. Delegate to explore in the background: list only the root files and directories of this repository, without editing anything. After the tool returns successfully, reply exactly RIGEL_NATIVE_V2_TASK_OK.`
  const result = childProcess.spawnSync(binary, [
    "--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", prompt,
  ], { cwd: sourceRoot, env, encoding: "utf8", timeout: 60_000 })
  const transcript = [`exit=${result.status}; signal=${result.signal}; error=${result.error?.message ?? ""}`, "--- stdout ---", result.stdout ?? "", "--- stderr ---", result.stderr ?? ""].join("\n")
  writeEvidence("native-delegation.txt", transcript)
  const runtimeLoaded = transcript.includes("[ho-my-rigel] Native OpenCode V2 runtime active:")
  const usedTask = new RegExp(`"tool":"${nativeTaskName}"|name=${nativeTaskName}`).test(transcript)
  const toolFailure = /"error":true|OpenCode V2 (callable-agent|agent inventory|category model inventory|child session could not be created)|Category ".+" requires/i.test(transcript)
  const resolved = !toolFailure
  const childCreated = /The subagent (is working|has been started).*sessionID:\s*ses_/i.test(transcript)
  const replied = transcript.includes("RIGEL_NATIVE_V2_TASK_OK")
  const report = [
    `# Ho My Rigel — native V2 ${category ? `category (${category})` : "named"} delegation`,
    "",
    "- Surface: real OpenCode V2 process with disposable HOME/XDG and native Rigel plugin only.",
    `- Native runtime loaded: ${runtimeLoaded ? "yes" : "no"}.`,
    `- Native task invoked: ${usedTask ? "yes" : "no"}.`,
    `- Named agent/category resolved without tool error: ${resolved ? "yes" : "no"}.`,
    `- Child session observed: ${childCreated ? "yes" : "no"}.`,
    `- Expected model acknowledgement: ${replied ? "yes" : "no"}.`,
    "- The native host subagent tool was disabled only in this sandbox so the proof cannot accidentally use it.",
  ].join("\n") + "\n"
  writeEvidence("validation.md", report)
  process.stdout.write(report)
  if (!runtimeLoaded || !usedTask || toolFailure || !resolved || !childCreated || !replied) process.exitCode = 1
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
