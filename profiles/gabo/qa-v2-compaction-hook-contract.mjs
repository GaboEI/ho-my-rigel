#!/usr/bin/env node
/**
 * Captures the real V2 compaction-hook propagation contract. The hook is
 * invoked, but in V2.0.22 mutations of `event.system` do not reach the
 * compaction provider request. This is evidence for a documented API gap,
 * not a passing migration claim.
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = "/home/gabodev/.opencode/bin/opencode"
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-compaction-"))
const configHome = path.join(temporary, "config")
const home = path.join(temporary, "home")
const plugin = path.join(temporary, "plugin")
const project = path.join(temporary, "project")
const traceFile = path.join(temporary, "provider-trace.jsonl")
const providerPort = 41364
const serverPort = 41365
const url = `http://127.0.0.1:${serverPort}`
const password = "rigel-v2-compaction-contract"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const evidence = path.join(root, ".omo/evidence/20261002-v2-compaction-hook-contract")

function save(name, value) {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidence, name), value, { mode: 0o600 })
}

function waitFor(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try { if (await check()) return resolve() } catch { /* starting */ }
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(attempt, 100)
    }
    attempt()
  })
}

async function api(pathname, init = {}) {
  const response = await fetch(`${url}${pathname}`, { ...init, headers: { authorization, ...init.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

try {
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.mkdirSync(project, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(plugin, "index.js"), `export default { id: "rigel-compaction-contract", setup: async (context) => {
    console.error("RIGEL_COMPACTION_SETUP=" + JSON.stringify(Object.keys(context.session ?? {}).sort()))
    await context.tool.transform((editor) => editor.add({
      name: "force_compact",
      options: { codemode: false },
      description: "Test-only native V2 compaction trigger.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, toolContext) => {
        await context.session.compact({ sessionID: toolContext.sessionID })
        return { content: "compaction started" }
      },
    }))
    await context.session.hook("compaction", async (event) => {
      console.error("RIGEL_COMPACTION_EVENT=" + JSON.stringify({ keys: Object.keys(event).sort(), system: event.system }))
      event.system.push({ type: "text", text: "RIGEL_V2_COMPACTION_CONTEXT_MARKER: keep continuity." })
    })
  } }\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel fixture", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "fixture" }, models: { fixture: { name: "Fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1000000, output: 512 } } } } },
    model: "rigel-fixture/fixture", plugin: [plugin], default_agent: "Build", agent: { Build: { mode: "primary", model: "rigel-fixture/fixture" } },
  }, null, 2) + "\n", { mode: 0o600 })
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temporary, "data"), XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache"), OPENCODE_SERVER_PASSWORD: password }
  const provider = childProcess.spawn(process.execPath, [path.join(root, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "force_compact", RIGEL_FAKE_TASK_ARGUMENTS: "{}", RIGEL_FAKE_PARENT_REPLY: "WORK_DONE" }, stdio: ["ignore", "pipe", "pipe"] })
  const server = childProcess.spawn(binary, ["--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  const logs = []
  for (const stream of [provider.stdout, provider.stderr, server.stdout, server.stderr]) stream?.on("data", (data) => logs.push(data.toString()))
  try {
    await waitFor(() => fetch(`${url}/api/session/active`, { headers: { authorization } }).then((response) => response.ok), "V2 server did not start")
    const created = await api("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Build", location: { directory: root } }) })
    const sessionID = created.id ?? created.data?.id
    if (typeof sessionID !== "string") throw new Error("V2 did not create a session")
    await api(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Prepare to compact.", resume: true }) })
    await waitFor(() => fs.existsSync(traceFile) && fs.readFileSync(traceFile, "utf8").includes("\"responseKind\":\"title\""), "V2 title request did not finish")
    await api(`/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Use force_compact now.", resume: true }) })
    await waitFor(() => logs.join("").includes("RIGEL_COMPACTION_EVENT="), "V2 compaction hook did not run")
    await new Promise((resolve) => setTimeout(resolve, 500))
    const trace = fs.readFileSync(traceFile, "utf8")
    const log = logs.join("")
    save("provider-trace.jsonl", trace)
    save("server.txt", log)
    const invoked = log.includes("RIGEL_COMPACTION_SETUP") && log.includes("RIGEL_COMPACTION_EVENT=")
    const propagated = trace.includes("RIGEL_V2_COMPACTION_CONTEXT_MARKER")
    const report = `# Rigel V2 compaction-hook propagation contract\n\n- Real isolated V2 server: yes.\n- Native compaction hook registered and invoked: ${invoked ? "yes" : "no"}.\n- Mutation of \`event.system\` reached the compaction model request: ${propagated ? "yes" : "no"}.\n- Result replacement used: no.\n- Finding: V2.0.22 invokes \`session.hook(\"compaction\")\` after, or outside, the mutable provider-request boundary; it cannot carry Rigel continuity context into the actual native summary.\n- V1 configuration read: no.\n`
    save("validation.md", report)
    process.stdout.write(report)
    if (!invoked || propagated) process.exitCode = 1
  } catch (error) {
    save("provider-trace.jsonl", fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "")
    save("server.txt", logs.join(""))
    throw error
  } finally { server.kill("SIGTERM"); provider.kill("SIGTERM") }
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
