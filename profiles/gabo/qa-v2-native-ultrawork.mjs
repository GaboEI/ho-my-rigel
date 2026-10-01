#!/usr/bin/env node
/** Proves the shipped native Rigel prompt hook reaches a real V2 model turn. */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-native-ulw-v2-"))
const runtime = path.join(temp, "plugin")
const configHome = path.join(temp, "config")
const evidence = path.join(root, ".omo/evidence/20261001-rigel-v2-native-ultrawork")
const live = JSON.parse(fs.readFileSync("/home/gabodev/.config/opencode/opencode.json", "utf8"))
function save(name, value) { fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(evidence, name), value, { mode: 0o600 }) }
try {
  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  for (const file of ["rigel-v2-native.mjs", "rigel-v2-native-core.mjs", "rigel-v2-native-prompt.mjs"]) fs.copyFileSync(path.join(root, "profiles/gabo/opencode", file), path.join(runtime, file === "rigel-v2-native.mjs" ? "index.js" : file))
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(runtime, "prompts/ultrawork-default.md"), "Reply exactly RIGEL_NATIVE_V2_ULTRAWORK_OK.", { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({ model: live.model, small_model: live.small_model, provider: live.provider, plugins: live.plugins, plugin: [runtime], default_agent: "Sisyphus - ultraworker", agent: { "Sisyphus - ultraworker": live.agent?.["Sisyphus - ultraworker"] } }, null, 2) + "\n", { mode: 0o600 })
  const result = childProcess.spawnSync("/home/gabodev/.opencode/bin/opencode", ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", "Reply only: BASE"], { cwd: root, env: { ...process.env, HOME: path.join(temp, "home"), XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temp, "data"), XDG_STATE_HOME: path.join(temp, "state"), XDG_CACHE_HOME: path.join(temp, "cache") }, encoding: "utf8", timeout: 60_000 })
  const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
  save("native-ultrawork.txt", transcript)
  const active = transcript.includes("[ho-my-rigel] Native OpenCode V2 runtime active:")
  const reached = transcript.includes("RIGEL_NATIVE_V2_ULTRAWORK_OK")
  const report = `# Ho My Rigel — native V2 ultrawork\n\n- Native runtime loaded: ${active ? "yes" : "no"}.\n- Native prompt directive reached model: ${reached ? "yes" : "no"}.\n- Disposable HOME/XDG only; live runtime untouched.\n`
  save("validation.md", report); process.stdout.write(report)
  if (!active || !reached) process.exitCode = 1
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
