#!/usr/bin/env node
/**
 * Phase A only: falsify/confirm whether OpenCode V2's AgentDomain can upsert
 * an agent. This intentionally loads no OmO/Rigel runtime or host plugins.
 */
import childProcess from "node:child_process"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const root = path.resolve(import.meta.dirname, "../..")
const evidence = path.join(root, ".omo/evidence/20261001-rigel-v2-agent-domain")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-agent-domain-"))
const home = path.join(temporary, "home")
const configHome = path.join(temporary, "config")
const plugin = path.join(temporary, "probe")
const probeName = "rigel-v2-agent-domain-probe"

function write(name, value) {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidence, name), value, { mode: 0o600 })
}

try {
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n")
  fs.writeFileSync(path.join(plugin, "index.js"), `
export default {
  id: "rigel-v2-agent-domain-probe",
  setup: async (context) => {
    const location = context.location
    const before = await context.agent.list({ location })
    let editorObservation
    await context.agent.transform((editor) => {
      // The transform callback is deliberately synchronous. We first inspect
      // the host-generated default shape instead of guessing V1 fields.
      const base = editor.default?.("${probeName}")
      const defaultWithoutId = editor.default?.()
      console.error("[rigel-agent-domain-editor] " + JSON.stringify({
        keys: Object.keys(editor), updateLength: editor.update?.length,
        defaultKeys: base && typeof base === "object" ? Object.keys(base) : [],
        defaultType: typeof base,
        defaultWithoutIdType: typeof defaultWithoutId,
        defaultWithoutIdKeys: defaultWithoutId && typeof defaultWithoutId === "object" ? Object.keys(defaultWithoutId) : [],
        defaultValue: base,
      }))
      if (!base || typeof base !== "object") return
      editor.update("${probeName}", {
        ...base,
        id: "${probeName}", name: "${probeName}", mode: "subagent", hidden: false,
        system: "Reply exactly RIGEL_AGENT_DOMAIN_OK.",
      })
      editorObservation = {
        hasAfterUpdate: Boolean(editor.get?.("${probeName}")),
        namesAfterUpdate: (editor.list?.() ?? []).map((agent) => agent.name),
      }
    })
    await context.agent.reload()
    const after = await context.agent.list({ location })
    console.error("[rigel-agent-domain-probe] " + JSON.stringify({
      before: (before.data ?? before).map((a) => a.name),
      after: (after.data ?? after).map((a) => a.name),
      hasTransform: typeof context.agent.transform === "function",
      editorObservation,
    }))
  },
}
`)
  fs.writeFileSync(path.join(configHome, "opencode", "opencode.json"), JSON.stringify({
    model: "opencode-go/deepseek-v4.1-flash",
    plugin: [plugin],
    plugins: [],
  }, null, 2) + "\n")
  const result = childProcess.spawnSync(binary, ["--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", probeName, "Reply exactly RIGEL_AGENT_DOMAIN_OK."], {
    cwd: root,
    env: { ...buildIsolatedV2Env({ sandbox: temporary, home: home }) },
    encoding: "utf8", timeout: 60_000,
  })
  const transcript = `exit=${result.status}; signal=${result.signal}\n${result.stdout}\n${result.stderr}`
  write("transcript.txt", transcript)
  const bridgeAbsent = !transcript.includes("[ho-my-rigel] OpenCode V2 bridge active:")
  const marker = transcript.match(/\[rigel-agent-domain-probe\] (.+)/)
  const editorMarker = transcript.match(/\[rigel-agent-domain-editor\] (.+)/)
  const observation = marker ? JSON.parse(marker[1]) : null
  const editor = editorMarker ? JSON.parse(editorMarker[1]) : null
  const accepted = Boolean(observation?.editorObservation?.hasAfterUpdate || observation?.editorObservation?.namesAfterUpdate?.includes(probeName))
  const appeared = Boolean(observation?.after?.includes(probeName) && !observation?.before?.includes(probeName))
  const report = JSON.stringify({ bridgeAbsent, editor, observation, accepted, appeared, modelReply: transcript.includes("RIGEL_AGENT_DOMAIN_OK") }, null, 2) + "\n"
  write("validation.json", report)
  process.stdout.write(report)
  if (!bridgeAbsent || !observation?.hasTransform || !appeared) process.exitCode = 1
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
