#!/usr/bin/env node
/**
 * T28 live experiment (lab-only): prove the Sisyphus runtime prompt
 * reconciliation on the real V2 `context` surface.
 *
 * V1 rebuilt the Sisyphus body per request in the system-transform hook when the
 * runtime model differed from the configured one (#5297/#5316/#6966). V2 exposes
 * the model at the `context` hook; the generator bakes the body for every model
 * the runtime can resolve for Sisyphus, and the hook swaps it in. This experiment
 * drives the REAL lab (`opencode-v2-lab.service`, port 4097) and reads the exact
 * wire payload the provider received:
 *
 *   - a loopback OpenAI-compatible mock is the provider; it records every request
 *     body it receives, so the observed system text is the payload, not a claim;
 *   - the lab config bakes the fallback body (model `rigel-t28/deepseek-v4.1-flash`)
 *     while a per-session model switch runs Sisyphus on other models;
 *   - for a model outside the baked set the reconciler must NOT swap and must
 *     report the miss observably (a durable receipt).
 *
 * Isolation: addresses only 127.0.0.1 (its own loopback port and lab 4097). The
 * refresh stops/starts ONLY opencode-v2-lab.service via
 * apply-v2-runtime-service.sh. V1 is read-only and its hash/counts are compared
 * before and after. No Docker, no direct opencode launch.
 *
 * Run: node profiles/gabo/qa-v2-t28-sisyphus-prompt.mjs
 */
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const worktreeRoot = path.resolve(here, "../..")
const evidenceDir = path.join(worktreeRoot, ".omo/evidence/20261007-t28-sisyphus-prompt/experiments")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const labConfig = path.join(labRoot, "config/opencode/opencode.json")
const secretFile = path.join(labRoot, "secret.env")
const labManifest = path.join(labRoot, "rigel/runtime/rigel-v2-agent-manifest.mjs")
const receiptFile = path.join(labRoot, "state/oh-my-rigel", "sisyphus-prompt-reconciled.json")
const labUrl = "http://127.0.0.1:4097"
const mockPort = Number(process.env.RIGEL_T28_MOCK_PORT || "41281")
const AGENT = "Sisyphus - ultraworker"
const bakedModel = "rigel-t28/deepseek-v4.1-flash"
const cases = [
  { id: "claude", modelId: "claude-opus-5-5", expect: "swap" },
  { id: "kimi", modelId: "kimi-k3", expect: "swap" },
  { id: "astra", modelId: "gpt-6-astra", expect: "swap" },
  { id: "astra-alias", modelId: "gpt-6-astra-fast", targetKey: "gpt-6-astra", expect: "swap" },
  { id: "configured", modelId: "deepseek-v4.1-flash", expect: "noop" },
  { id: "unbaked", modelId: "zeta-probe-model", expect: "unbaked" },
  { id: "astra-impostor", modelId: "custom-gpt-6-astra", expect: "unbaked" },
]

function readPassword() {
  const line = fs.readFileSync(secretFile, "utf8").split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  return line ? line.slice("OPENCODE_PASSWORD=".length).trim() : ""
}
const authorization = `Basic ${Buffer.from(`opencode:${readPassword()}`).toString("base64")}`

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")
}
function countFiles(directory) {
  let files = 0
  const walk = (current) => {
    let items = []
    try { items = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const itemPath = path.join(current, item.name)
      if (item.isDirectory()) walk(itemPath)
      else if (item.isFile()) files += 1
    }
  }
  walk(directory)
  return files
}
function snapshotV1() {
  const configDir = path.join(os.homedir(), ".config/opencode")
  const shareDir = path.join(os.homedir(), ".local/share/opencode")
  const stable = []
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const file = path.join(configDir, name)
    if (fs.existsSync(file)) stable.push(`${name}:${sha256(fs.readFileSync(file))}`)
  }
  return { configFiles: countFiles(configDir), shareFiles: countFiles(shareDir), configHash: sha256(stable.join("\n")) }
}
function waitFor(check, message, timeout = 180_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    let lastFailure
    const attempt = async () => {
      try { if (await check()) return resolve() } catch (error) { lastFailure = error }
      if (Date.now() >= deadline) {
        return reject(new Error(`${message} (last check: ${lastFailure instanceof Error ? lastFailure.message : "no failure recorded"})`))
      }
      setTimeout(attempt, 250)
    }
    attempt()
  })
}
async function labApi(pathname, init = {}) {
  const response = await fetch(`${labUrl}${pathname}`, { ...init, headers: { authorization, ...init.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}
async function waitIdleLab(sessionID, timeout = 60_000) {
  try {
    await fetch(`${labUrl}/api/experimental/session/${sessionID}/wait`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeout),
    })
    return "wait-endpoint"
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unavailable"
  }
}
async function newSession(modelId) {
  const created = await labApi("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: AGENT, model: { id: modelId, providerID: "rigel-t28" }, location: { directory: worktreeRoot } }),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string") throw new Error(`session create failed: ${JSON.stringify(created).slice(0, 200)}`)
  await labApi(`/api/session/${sessionID}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { id: modelId, providerID: "rigel-t28" } }),
  })
  return sessionID
}

/** Loopback OpenAI-compatible provider that records the exact body it receives. */
function startMock() {
  const bodies = []
  const server = http.createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    let parsed
    try { parsed = JSON.parse(raw || "{}") } catch { parsed = { raw } }
    bodies.push({ url: request.url, body: parsed })
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t28", object: "chat.completion.chunk", created: 0, model: "rigel-t28", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t28", object: "chat.completion.chunk", created: 0, model: "rigel-t28", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(mockPort, "127.0.0.1", () => resolve({
      server, bodies, url: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
      close: () => new Promise((done) => server.close(() => done())),
    }))
  })
}

function systemText(body) {
  const parts = []
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (const message of messages) {
    if (message?.role !== "system") continue
    if (typeof message.content === "string") parts.push(message.content)
    else if (Array.isArray(message.content)) parts.push(message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(""))
  }
  if (typeof body?.system === "string") parts.push(body.system)
  if (typeof body?.instructions === "string") parts.push(body.instructions)
  return parts.join("\n")
}

function readManifest() {
  const src = fs.readFileSync(labManifest, "utf8")
  return JSON.parse(src.slice(src.indexOf("{")))
}
function blockquoteCount(body) {
  return typeof body === "string" ? body.split("\n").filter((line) => /^\s*>.*\[[^\]]+\]/.test(line)).length : -1
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const v1Before = snapshotV1()
  const packagesByteIdentical = childProcess.spawnSync("git", ["diff", "--quiet", "--", "packages/"], { cwd: worktreeRoot }).status === 0
  console.log(`[t28] V1 before: cfgHash=${v1Before.configHash.slice(0, 12)} config#${v1Before.configFiles} share#${v1Before.shareFiles}; packages/ byte-identical=${packagesByteIdentical}`)

  const original = fs.readFileSync(labConfig, "utf8")
  const mock = await startMock()
  const results = {}
  const failures = []
  let manifestChecks = null
  let restored = false
  const restoreLab = () => {
    if (restored) return
    restored = true
    fs.writeFileSync(labConfig, original)
    childProcess.spawnSync("bash", [path.join(worktreeRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: worktreeRoot, stdio: "inherit", timeout: 300_000 })
  }

  try {
    const config = JSON.parse(original)
    config.provider = config.provider ?? {}
    config.provider["rigel-t28"] = {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "rigel-t28-no-secret" },
      models: Object.fromEntries(
        ["claude-opus-5-5", "kimi-k3", "gpt-6-astra", "gpt-6-astra-fast", "custom-gpt-6-astra", "gpt-6-sol", "deepseek-v4.1-flash", "zeta-probe-model"].map((id) => [id, {
          name: `T28 ${id}`, tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1000000, output: 8192 },
        }]),
      ),
    }
    config.model = bakedModel
    config.small_model = bakedModel
    fs.writeFileSync(labConfig, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })

    console.log(`[t28] refresh root=${worktreeRoot}; baked model=${bakedModel}`)
    const refresh = childProcess.spawnSync("bash", [path.join(worktreeRoot, "profiles/gabo/apply-v2-runtime-service.sh")], { cwd: worktreeRoot, stdio: "inherit", timeout: 300_000 })
    if (refresh.status !== 0) throw new Error(`lab refresh failed with status ${refresh.status}`)
    await waitFor(async () => {
      try { const response = await fetch(`${labUrl}/api/info`, { headers: { authorization } }); await response.arrayBuffer(); return response.ok } catch { return false }
    }, "lab did not come back")

    const manifest = readManifest()
    const plan = manifest?.metadata?.global?.sisyphusPrompt
    if (!plan) throw new Error("lab manifest carries no sisyphusPrompt plan")
    manifestChecks = {
      sisyphusBlockquotes: blockquoteCount(manifest.agents?.[AGENT]?.prompt ?? ""),
      nonTargetBlockquotes: blockquoteCount(manifest.agents?.["Hephaestus - Deep Agent"]?.prompt ?? ""),
    }
    fs.writeFileSync(path.join(evidenceDir, "manifest-checks.json"), JSON.stringify({ packagesByteIdentical, manifestChecks }, null, 2) + "\n", { mode: 0o600 })
    console.log(`[t28] manifest: sisyphusBlockquotes=${manifestChecks.sisyphusBlockquotes} nonTargetBlockquotes=${manifestChecks.nonTargetBlockquotes}`)
    fs.writeFileSync(path.join(evidenceDir, "plan.json"), JSON.stringify({ bakedModel: plan.bakedModel, bakedPromptLen: plan.bakedPrompt.length, byModel: Object.fromEntries(Object.entries(plan.promptByModel).map(([k, v]) => [k, v.length])) }, null, 2) + "\n", { mode: 0o600 })
    console.log(`[t28] bakedModel=${plan.bakedModel} bakedLen=${plan.bakedPrompt.length} byModel=${Object.keys(plan.promptByModel).join(",")}`)

    for (const testCase of cases) {
      fs.rmSync(receiptFile, { force: true })
      const before = mock.bodies.length
      const sessionID = await newSession(testCase.modelId)
      await labApi(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `T28 probe ${testCase.id}`, resume: true }),
      })
      const idle = await waitIdleLab(sessionID)
      const captured = mock.bodies.slice(before)
      const agentBody = captured.map((entry) => entry.body).find((body) => systemText(body).includes("Sisyphus")) ?? captured[0]?.body
      const text = agentBody ? systemText(agentBody) : ""
      let receipt = null
      try { receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) } catch { receipt = null }
      const target = plan.promptByModel[testCase.targetKey ?? testCase.modelId]
      const blockquoteExamples = text.split("\n").filter((line) => /^\s*>.*\[[^\]]+\]/.test(line))
      const identity = (text.match(/based on ([^\n.]+)/) ?? [])[1]
      results[testCase.id] = {
        modelId: testCase.modelId,
        idle,
        bodies: captured.length,
        hasBaked: text.includes(plan.bakedPrompt),
        hasTarget: typeof target === "string" && text.includes(target),
        blockquoteExamples: blockquoteExamples.length,
        identity: identity ? identity.trim() : null,
        receipt,
      }
      fs.writeFileSync(path.join(evidenceDir, `T28-${testCase.id}.json`), JSON.stringify({ ...results[testCase.id], systemLen: text.length }, null, 2) + "\n", { mode: 0o600 })
      console.log(`[t28] ${testCase.id} (${testCase.modelId}): idle=${idle} bodies=${captured.length} hasBaked=${results[testCase.id].hasBaked} hasTarget=${results[testCase.id].hasTarget} receipt=${JSON.stringify(receipt)}`)

      if (blockquoteExamples.length > 0) failures.push(`${testCase.id}: accidental blockquote format example in the wire payload`)
      if (testCase.expect === "swap") {
        if (!results[testCase.id].hasTarget) failures.push(`${testCase.id}: reconciled body missing from the wire payload`)
        if (results[testCase.id].hasBaked) failures.push(`${testCase.id}: baked fallback body still present in the wire payload`)
        if (!(receipt && receipt.reconciled === true && receipt.reason === "swapped")) failures.push(`${testCase.id}: no durable "swapped" receipt`)
      } else if (testCase.expect === "noop") {
        // The configured model's target body IS the baked body, so the only
        // meaningful checks are: the baked body stayed and no swap was recorded.
        if (!results[testCase.id].hasBaked) failures.push(`${testCase.id}: baked body should remain for the configured model`)
        if (receipt && receipt.reconciled === true) failures.push(`${testCase.id}: unexpected swap receipt for the configured model`)
      } else if (testCase.expect === "unbaked") {
        if (!results[testCase.id].hasBaked) failures.push(`${testCase.id}: baked body should remain when the model is not baked`)
        if (!(receipt && receipt.reconciled === false && receipt.reason === "model-not-baked")) failures.push(`${testCase.id}: missing "model-not-baked" receipt`)
      }
    }
  } finally {
    try { await mock.close() } catch (error) {
      console.error(`[t28] mock close failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    restoreLab()
  }

  if (!packagesByteIdentical) failures.push("packages/ owners are not byte-identical to HEAD")
  if (manifestChecks && manifestChecks.sisyphusBlockquotes !== 0) failures.push("manifest Sisyphus body carries a blockquote format example")
  if (manifestChecks && manifestChecks.nonTargetBlockquotes < 1) failures.push("non-target agent body lost its format example (fix leaked beyond Sisyphus)")

  const v1After = snapshotV1()
  // V1's config is the protected surface: its hash must be identical. V1 is a
  // live production process, so its own `share` store (session/TUI state) is
  // written continuously and its file count legitimately drifts; that drift is
  // recorded, not treated as a change this experiment caused.
  const v1Intact = v1Before.configHash === v1After.configHash && v1Before.configFiles === v1After.configFiles
  const v1ShareCountsDrift = v1Before.shareFiles !== v1After.shareFiles
  const report = { bakedModel, packagesByteIdentical, manifestChecks, v1ShareCountsDrift, cases: results, failures, v1: { before: v1Before, after: v1After, intact: v1Intact } }
  fs.writeFileSync(path.join(evidenceDir, "T28-result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))

  if (failures.length > 0) { console.error(`T28 live experiment FAILED: ${failures.length} assertion(s)`); process.exit(1) }
  if (!v1Intact) { console.error("T28 live experiment FAILED: V1 snapshot changed"); process.exit(1) }
  console.log("T28 live experiment PASSED (lab-only; wire payload reconciled per model; unbaked model reported; V1 intact)")
}

main().catch((error) => {
  console.error(`T28 live experiment error: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
