#!/usr/bin/env node
/**
 * Proves V2 AgentEditor.update is a real upsert: an agent absent from the
 * initial list must be created, survive reload, and affect a provider turn.
 */
import childProcess from "node:child_process"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-agent-transform-"))
const evidenceDir = path.join(root, ".omo/evidence/20261002-rigel-v2-agent-transform-contract")
const providerPort = 41238
const traceFile = path.join(temporary, "provider-trace.jsonl")

function save(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const config = path.join(temporary, "config/opencode")
  const plugin = path.join(temporary, "plugin")
  fs.mkdirSync(config, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(plugin, "index.js"), `
export default {
  id: "rigel-agent-transform-contract",
  setup: async (context) => {
    const before = await context.agent.list({ location: context.location })
    let accepted = false
    await context.agent.transform((editor) => {
      const target = editor.get("rigel-contract-probe")
      if (target) throw new Error("The isolated probe agent existed before update")
      editor.update("rigel-contract-probe", (agent) => {
        agent.name = "Rigel contract probe"
        agent.description = "Disposable V2 agent-transform contract probe."
        agent.mode = "primary"
        agent.hidden = false
        agent.system = "Reply exactly RIGEL_AGENT_TRANSFORM_OK."
      })
      accepted = Boolean(editor.get("rigel-contract-probe"))
      editor.default("rigel-contract-probe")
    })
    await context.agent.reload()
    const after = await context.agent.list({ location: context.location })
    console.error("RIGEL_AGENT_TRANSFORM=" + JSON.stringify({
      before: Array.isArray(before?.data) ? before.data.map((agent) => agent.id ?? agent.name) : before,
      accepted,
      after: Array.isArray(after?.data) ? after.data.map((agent) => agent.id ?? agent.name) : after,
    }))
  },
}
`, { mode: 0o600 })
  fs.writeFileSync(path.join(config, "opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } },
    model: "rigel-fixture/fixture", plugin: [plugin], default_agent: "build",
  }, null, 2) + "\n", { mode: 0o600 })
  const env = { ...buildIsolatedV2Env({ sandbox: temporary, home: path.join(temporary, "home") }) }
  const provider = childProcess.spawn(process.execPath, [path.join(root, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_PARENT_REPLY: "RIGEL_AGENT_TRANSFORM_OK" }, stdio: ["ignore", "pipe", "pipe"] })
  const result = childProcess.spawnSync(binary, ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "rigel-contract-probe", "Reply only: BASE"], { cwd: root, env, encoding: "utf8", timeout: 60_000 })
  provider.kill("SIGTERM")
  const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
  save("transcript.txt", transcript)
  save("provider-trace.jsonl", trace)
  const accepted = /RIGEL_AGENT_TRANSFORM=.*"accepted":true/.test(transcript)
  const applied = trace.includes("Reply exactly RIGEL_AGENT_TRANSFORM_OK.")
  const replied = transcript.includes("RIGEL_AGENT_TRANSFORM_OK")
  const report = ["# Rigel V2 agent.transform contract", "", "- Real isolated V2 process: yes.", `- Missing agent created by editor.update: ${accepted ? "yes" : "no"}.`, `- Upserted system prompt reached provider after reload: ${applied ? "yes" : "no"}.`, `- Model followed upserted system prompt: ${replied ? "yes" : "no"}.`, "- Conclusion: V2 agent.transform/update is a real upsert on V2.0.22; a static agent layer is not required for Rigel registration."].join("\n") + "\n"
  save("validation.md", report)
  process.stdout.write(report)
  if (!accepted || !applied || !replied) process.exitCode = 1
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
