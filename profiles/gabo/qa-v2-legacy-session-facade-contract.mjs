#!/usr/bin/env node
/**
 * Proves the legacy bridge's task-facing facade against a real disposable V2
 * server. The fake legacy tool deliberately uses the V1 SDK shapes for
 * app.agents(), session.get(), session.create(), and session.prompt().
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = "/home/gabodev/.opencode/bin/opencode"
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261002-rigel-v2-legacy-session-facade")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-legacy-facade-"))
const configHome = path.join(temporary, "config")
const home = path.join(temporary, "home")
const runtime = path.join(temporary, "plugin")
const providerPort = 41236
const serverPort = 41237
const serverURL = `http://127.0.0.1:${serverPort}`
const password = "rigel-disposable-server-only"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const traceFile = path.join(temporary, "provider-trace.jsonl")

function save(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

function waitFor(check, message, timeout = 20_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try { if (await check()) return resolve() } catch { /* still starting */ }
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(attempt, 100)
    }
    attempt()
  })
}

async function api(url, init) {
  const response = await fetch(url, { ...init, headers: { authorization, ...init?.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

try {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const core = pathToFileURL(path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter-core.mjs")).href
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter-core.mjs"), path.join(runtime, "omo-v2-adapter-core.mjs"))
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(runtime, "index.js"), `
import { createRigelV2Plugin } from ${JSON.stringify(core)}
export default createRigelV2Plugin({
  id: "rigel-v2-legacy-session-facade-contract",
  loadLegacyHooks: async () => ({
    tool: {
      legacy_facade_task: {
        description: "Exercise the V1 client facade over native V2 sessions.",
        args: {},
        execute: async (_input, context) => {
          const inventory = await context.client.app.agents({ directory: context.directory })
          const parent = await context.client.session.get({ path: { id: context.sessionID } })
          const created = await context.client.session.create({
            body: { parentID: context.sessionID, title: "legacy-facade child" },
            query: { directory: parent.data.directory },
          })
          await context.client.session.prompt({
            path: { id: created.data.id },
            body: { agent: "explore", parts: [{ type: "text", text: "<legacy-facade-child> Reply exactly LEGACY_FACADE_CHILD_OK." }] },
          })
          return { output: JSON.stringify({ callableAgents: inventory.data.length, childSessionID: created.data.id }) }
        },
      },
    },
  }),
})
`, { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } },
    model: "rigel-fixture/fixture", plugin: [runtime], default_agent: "Sisyphus - ultraworker",
    agent: { "Sisyphus - ultraworker": { mode: "primary", model: "rigel-fixture/fixture" }, explore: { mode: "subagent", model: "rigel-fixture/fixture" } },
  }, null, 2) + "\n", { mode: 0o600 })
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temporary, "data"), XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache"), OPENCODE_SERVER_PASSWORD: password }
  const provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "legacy_facade_task", RIGEL_FAKE_TASK_ARGUMENTS: "{}", RIGEL_FAKE_CHILD_MARKER: "<legacy-facade-child>", RIGEL_FAKE_CHILD_REPLY: "LEGACY_FACADE_CHILD_OK", RIGEL_FAKE_PARENT_REPLY: "LEGACY_FACADE_PARENT_OK" }, stdio: ["ignore", "pipe", "pipe"] })
  const server = childProcess.spawn(binary, ["--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], { cwd: sourceRoot, env, stdio: ["ignore", "pipe", "pipe"] })
  const logs = []
  for (const stream of [provider.stderr, server.stdout, server.stderr]) stream?.on("data", (chunk) => logs.push(chunk.toString()))
  try {
    await waitFor(() => fetch(`${serverURL}/api/session/active`, { headers: { authorization } }).then((response) => response.ok), "The isolated V2 bridge server did not start")
    const created = await api(`${serverURL}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Sisyphus - ultraworker", location: { directory: sourceRoot } }) })
    const parentID = created.id ?? created.data?.id
    if (typeof parentID !== "string") throw new Error("V2 did not return a parent session ID")
    await api(`${serverURL}/api/session/${parentID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Call legacy_facade_task exactly once, then report completion.", resume: true }) })
    await waitFor(() => {
      const rows = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
      return rows.some((row) => row.toolNames?.includes("legacy_facade_task"))
        && rows.some((row) => row.messages?.some((message) => String(message.content).includes("<legacy-facade-child>")))
        && rows.some((row) => row.hasToolResult)
    }, "The legacy facade did not create and prompt a child session")
    const transcript = logs.join("")
    const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
    save("legacy-session-facade.txt", transcript)
    save("provider-trace.jsonl", trace)
    const rows = trace.trim().split("\n").filter(Boolean).map(JSON.parse)
    const loaded = transcript.includes("OpenCode V2 bridge active")
    const liveInventory = transcript.includes("V2 agent inventory: context.agent.list")
    const toolVisible = rows.some((row) => row.toolNames?.includes("legacy_facade_task"))
    const childPrompted = rows.some((row) => row.messages?.some((message) => String(message.content).includes("<legacy-facade-child>")))
    const parentReceivedResult = rows.some((row) => row.hasToolResult)
    const report = ["# Rigel V2 legacy session facade contract", "", "- Real isolated V2 server: yes.", `- Bridge loaded: ${loaded ? "yes" : "no"}.`, `- Inventory came from context.agent.list: ${liveInventory ? "yes" : "no"}.`, `- Legacy tool was visible to the provider: ${toolVisible ? "yes" : "no"}.`, `- Legacy session.get/create/prompt made a real child request: ${childPrompted ? "yes" : "no"}.`, `- Parent received the legacy tool result: ${parentReceivedResult ? "yes" : "no"}.`].join("\n") + "\n"
    save("validation.md", report)
    process.stdout.write(report)
    if (!loaded || !liveInventory || !toolVisible || !childPrompted || !parentReceivedResult) process.exitCode = 1
  } catch (error) {
    save("startup-failure.txt", logs.join(""))
    throw error
  } finally {
    server.kill("SIGTERM")
    provider.kill("SIGTERM")
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
