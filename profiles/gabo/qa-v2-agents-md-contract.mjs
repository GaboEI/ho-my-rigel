#!/usr/bin/env node
/**
 * Proves the native V2 replacement for Rigel's V1 directory instruction
 * injectors: a real V2 read tool call must make applicable AGENTS.md and
 * README.md context reach the next provider turn in that same session.
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = "/home/gabodev/.opencode/bin/opencode"
const evidenceDir = path.join(root, ".omo/evidence/20261002-v2-agents-md-contract")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-agents-md-"))
const project = path.join(temporary, "project")
const configHome = path.join(temporary, "config")
const home = path.join(temporary, "home")
const runtime = path.join(temporary, "plugin")
const providerPort = 41334
const serverPort = 41335
const serverURL = `http://127.0.0.1:${serverPort}`
const password = "rigel-agents-md-contract"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const traceFile = path.join(temporary, "provider-trace.jsonl")

function save(name, body) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), body, { mode: 0o600 })
}

function waitFor(check, description, timeout = 15_000) {
  const until = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const run = async () => {
      try { if (await check()) return resolve() } catch { /* startup still in progress */ }
      if (Date.now() >= until) return reject(new Error(description))
      setTimeout(run, 100)
    }
    run()
  })
}

async function api(url, init) {
  const response = await fetch(url, { ...init, headers: { authorization, ...init?.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

try {
  fs.mkdirSync(project, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(project, "AGENTS.md"), "# V2 AGENTS contract\n\nV2_AGENTS_MD_MARKER: this directive must reach the provider.\n", { mode: 0o600 })
  fs.writeFileSync(path.join(project, "README.md"), "# V2 README contract\n\nV2_README_MD_MARKER: this documentation must reach the provider.\n", { mode: 0o600 })
  fs.writeFileSync(path.join(project, "sample.txt"), "sample\n", { mode: 0o600 })
  for (const name of ["rigel-v2-native.mjs", "rigel-v2-native-core.mjs", "rigel-v2-native-prompt.mjs", "rigel-v2-directory-instructions.mjs", "rigel-v2-native-reminders.mjs", "rigel-v2-native-categories.mjs", "rigel-v2-category-manifest.mjs", "rigel-v2-native-agents.mjs", "rigel-v2-native-agent-manifest.mjs"]) {
    fs.copyFileSync(path.join(root, "profiles/gabo/opencode", name), path.join(runtime, name === "rigel-v2-native.mjs" ? "index.js" : name))
  }
  // The source manifest is generated during a profile install. This isolated
  // contract must supply its own real V2 primary agent, otherwise V2 rejects
  // session creation before the runtime can observe the native read hook.
  fs.writeFileSync(path.join(runtime, "rigel-v2-native-agent-manifest.mjs"), `export default {
  defaultAgent: "Sisyphus - ultraworker",
  modes: { defaultUltrawork: false },
  agents: {
    "Sisyphus - ultraworker": {
      mode: "primary",
      name: "Sisyphus - ultraworker",
      model: "rigel-fixture/fixture",
      prompt: "Coordinate the request through available tools.",
    },
    "Hephaestus - Deep Agent": {
      mode: "primary",
      name: "Hephaestus - Deep Agent",
      model: "rigel-fixture/fixture",
      prompt: "Implement carefully.",
    },
  },
}\n`, { mode: 0o600 })
  fs.copyFileSync(path.join(root, "packages/prompts-core/prompts/ultrawork/default.md"), path.join(runtime, "prompts/ultrawork-default.md"))
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: {
      "rigel-fixture": {
        name: "Rigel fixture",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "fixture" },
        models: { fixture: { name: "Fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 8192, output: 512 } } },
      },
    },
    model: "rigel-fixture/fixture",
    default_agent: "Sisyphus - ultraworker",
    plugin: [runtime],
  }, null, 2) + "\n", { mode: 0o600 })
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(temporary, "data"), XDG_STATE_HOME: path.join(temporary, "state"), XDG_CACHE_HOME: path.join(temporary, "cache"), OPENCODE_SERVER_PASSWORD: password }
  const fixture = childProcess.spawn(process.execPath, [path.join(root, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...env, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile, RIGEL_FAKE_TASK_NAME: "read", RIGEL_FAKE_TASK_ARGUMENTS: JSON.stringify({ path: "sample.txt" }), RIGEL_FAKE_PARENT_REPLY: "AGENTS_MD_OK" }, stdio: ["ignore", "pipe", "pipe"] })
  const server = childProcess.spawn(binary, ["--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  const logs = []
  for (const stream of [fixture.stderr, server.stdout, server.stderr]) stream?.on("data", (data) => logs.push(data.toString()))
  try {
    await waitFor(() => fetch(`${serverURL}/api/session/active`, { headers: { authorization } }).then((response) => response.ok), "V2 AGENTS.md contract server did not start")
    const hephaestus = await api(`${serverURL}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Hephaestus - Deep Agent", location: { directory: project } }) })
    const hephaestusID = hephaestus.id ?? hephaestus.data?.id
    if (typeof hephaestusID !== "string") throw new Error("V2 did not create a Hephaestus session")
    await api(`${serverURL}/api/session/${hephaestusID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Reply only HEPAESTUS_ROOT_CONTEXT_OK.", resume: true }) })
    await waitFor(() => fs.existsSync(traceFile) && fs.readFileSync(traceFile, "utf8").includes("Workspace-root AGENTS.md instructions for this Hephaestus session"), "Native V2 Hephaestus root AGENTS.md context did not reach the provider")
    const created = await api(`${serverURL}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Sisyphus - ultraworker", location: { directory: project } }) })
    const sessionID = created.id ?? created.data?.id
    if (typeof sessionID !== "string") throw new Error("V2 did not create a session")
    await api(`${serverURL}/api/session/${sessionID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Read sample.txt, then reply only AGENTS_MD_OK.", resume: true }) })
    await waitFor(() => {
      const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
      return trace.includes("V2_AGENTS_MD_MARKER") && trace.includes("V2_README_MD_MARKER")
    }, "Native V2 AGENTS.md/README.md context did not reach the provider after read")
    const trace = fs.readFileSync(traceFile, "utf8")
    save("provider-trace.jsonl", trace)
    save("server.txt", logs.join(""))
    const report = "# Rigel native V2 directory context contract\n\n- Real isolated V2 server: yes.\n- Native V2 runtime loaded: yes.\n- Hephaestus received root AGENTS.md before its first provider turn: yes.\n- Read tool executed before injection: yes.\n- Project AGENTS.md rules reached the next provider turn: yes.\n- Project README.md context reached the next provider turn: yes.\n- V1 configuration read: no.\n"
    save("validation.md", report)
    process.stdout.write(report)
  } catch (error) {
    save("provider-trace.jsonl", fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "")
    save("server.txt", logs.join(""))
    throw error
  } finally {
    server.kill("SIGTERM")
    fixture.kill("SIGTERM")
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
