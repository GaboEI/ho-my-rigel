#!/usr/bin/env node
/** Proves the V2 prompt-hook mutation contract with a disposable native plugin. */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const liveConfig = path.join(os.homedir(), ".config/opencode/opencode.json")
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261001-rigel-v2-native-prompt-contract")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-native-prompt-v2-"))
const configHome = path.join(temporary, "config")
const home = path.join(temporary, "home")
const runtime = path.join(temporary, "plugin")

function writeEvidence(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const live = JSON.parse(fs.readFileSync(liveConfig, "utf8"))
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(runtime, "index.js"), `
export default {
  id: "rigel-v2-prompt-contract",
  setup: async (context) => {
    console.error("RIGEL_V2_PROMPT_PROBE_SETUP")
    await context.tool.transform((editor) => editor.add({
      name: "rigel_prompt_contract_probe",
      description: "isolated V2 contract probe",
      input: {},
      execute: async () => ({ content: "probe" }),
    }))
    await context.session.hook("prompt", async (input) => {
      const shape = {
        keys: Object.keys(input ?? {}).sort(),
        promptType: Array.isArray(input?.prompt) ? "array" : typeof input?.prompt,
        promptKeys: input?.prompt && typeof input.prompt === "object" ? Object.keys(input.prompt).sort() : [],
        metadata: input?.metadata ?? null,
      }
      console.error("RIGEL_V2_PROMPT_SHAPE=" + JSON.stringify(shape))
      const directive = "\\n[rigel native V2 contract] Reply exactly RIGEL_V2_PROMPT_HOOK_OK."
      if (input?.prompt && typeof input.prompt === "object" && typeof input.prompt.text === "string") input.prompt.text += directive
      else if (typeof input?.prompt === "string") input.prompt += directive
      else console.error("RIGEL_V2_PROMPT_MUTATION=unsupported")
    })
  },
}
`, { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    model: live.model,
    small_model: live.small_model,
    provider: live.provider,
    plugins: live.plugins,
    plugin: [runtime],
    default_agent: "Sisyphus - ultraworker",
    agent: { "Sisyphus - ultraworker": live.agent?.["Sisyphus - ultraworker"] },
  }, null, 2) + "\n", { mode: 0o600 })
  const result = childProcess.spawnSync(binary, [
    "--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", "Reply only: BASE",
  ], { cwd: sourceRoot, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temporary, "data"), XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache") }, encoding: "utf8", timeout: 60_000 })
  const transcript = [`exit=${result.status}; signal=${result.signal}; error=${result.error?.message ?? ""}`, "--- stdout ---", result.stdout ?? "", "--- stderr ---", result.stderr ?? ""].join("\n")
  writeEvidence("prompt-contract.txt", transcript)
  const setup = transcript.includes("RIGEL_V2_PROMPT_PROBE_SETUP")
  const shape = transcript.match(/RIGEL_V2_PROMPT_SHAPE=([^\n]+)/)?.[1] ?? "not observed"
  const propagated = transcript.includes("RIGEL_V2_PROMPT_HOOK_OK")
  const report = [
    "# Ho My Rigel — native V2 prompt contract",
    "",
    `- Native probe setup: ${setup ? "yes" : "no"}.`,
    `- Prompt shape: ${shape}.`,
    `- Prompt mutation reached the model: ${propagated ? "yes" : "no"}.`,
    "- Surface: real OpenCode V2 process with disposable HOME/XDG and no live Rigel runtime.",
  ].join("\n") + "\n"
  writeEvidence("validation.md", report)
  process.stdout.write(report)
  if (!setup || !propagated) process.exitCode = 1
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
