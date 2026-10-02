#!/usr/bin/env node
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = "/home/gabodev/.opencode/bin/opencode"
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261002-rigel-v2-chat-message-contract")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-chat-message-"))
const providerPort = 41239
const traceFile = path.join(temp, "provider-trace.jsonl")
let provider

function write(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const configHome = path.join(temp, "config")
  const home = path.join(temp, "home")
  const plugin = path.join(temp, "plugin")
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  const core = pathToFileURL(path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter-core.mjs")).href
  fs.writeFileSync(path.join(plugin, "index.js"), `
import { createRigelV2Plugin } from ${JSON.stringify(core)}
export default createRigelV2Plugin({
  id: "rigel-v2-chat-message-contract",
  loadLegacyHooks: async () => ({
    tool: {},
    "chat.message": async (_input, output) => {
      output.parts = [{ type: "text", text: "Reply with exactly RIGEL_V2_CHAT_MESSAGE_OK." }]
    },
  }),
})
`)
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } },
    model: "rigel-fixture/fixture", plugin: [plugin], default_agent: "Sisyphus - ultraworker",
    agent: { "Sisyphus - ultraworker": { mode: "primary", model: "rigel-fixture/fixture" } },
  }, null, 2) + "\n")
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temp, "data"), XDG_STATE_HOME: path.join(temp, "state"), XDG_CACHE_HOME: path.join(temp, "cache") }
  provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_PARENT_REPLY: "RIGEL_V2_CHAT_MESSAGE_OK" }, stdio: "ignore" })
  const result = childProcess.spawnSync(binary, ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", "Reply only: BASE"], {
    cwd: sourceRoot,
    env,
    encoding: "utf8", timeout: 60_000,
  })
  const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
  write("transcript.txt", transcript)
  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
  write("provider-trace.jsonl", trace)
  const passed = transcript.includes("RIGEL_V2_CHAT_MESSAGE_OK") && transcript.includes("OpenCode V2 bridge active") && trace.includes("Reply with exactly RIGEL_V2_CHAT_MESSAGE_OK.")
  write("validation.md", `# Rigel V2 chat.message contract\n\n- Real isolated V2 process: yes.\n- Legacy handler output reached provider: ${passed ? "yes" : "no"}.\n`)
  process.stdout.write(`chat.message contract: ${passed ? "PASS" : "FAIL"}\n`)
  if (!passed) process.exitCode = 1
} finally { provider?.kill("SIGTERM"); fs.rmSync(temp, { recursive: true, force: true }) }
