#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { evalSmokeProviderSource } from "./omo-native-eval-smoke-provider.mjs"

function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === "--binary") return { binary: resolve(argv[1]) }
  throw new Error("usage: bun script/qa/omo-native-eval-smoke.mjs --binary <path>")
}

function isolatedEnvironment(home, agentDir, sessionDir) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("SENPI_") || key.startsWith("OMO_") || key.startsWith("PI_")) continue
    if (key.endsWith("CODING_AGENT_DIR") || key.endsWith("CODING_AGENT_SESSION_DIR")) continue
    if (/TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|API_KEY/i.test(key)) continue
    env[key] = value
  }
  return {
    ...env,
    HOME: home,
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  }
}

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "omo-eval-smoke-"))
  const home = join(root, "home")
  const cwd = join(root, "project")
  const agentDir = join(root, "agent")
  const sessionDir = join(root, "sessions")
  for (const directory of [home, cwd, agentDir, sessionDir]) mkdirSync(directory, { recursive: true })
  mkdirSync(join(agentDir, "omo-senpi", "omo-native"), { recursive: true })
  writeFileSync(join(agentDir, "omo-senpi", "omo-native", "onboarding-completed"), '{"version":1}\n')
  writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [realpathSync(cwd)]: true }, null, 2)}\n`)
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProjectTrust: "ask",
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-sol",
  }, null, 2)}\n`)
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      openai: {
        models: [{ id: "gpt-5.6-sol", name: "Eval Smoke", contextWindow: 200000, maxTokens: 4096 }],
      },
    },
  }, null, 2)}\n`)
  const providerPath = join(root, "eval-smoke-provider.ts")
  writeFileSync(providerPath, evalSmokeProviderSource())
  return { root, home, cwd, agentDir, sessionDir, providerPath }
}

async function drive(binary, sandbox) {
  const child = spawn(binary, [
    "--mode", "rpc", "--offline", "--approve", "--no-context-files",
    "--session-dir", sandbox.sessionDir,
    "-e", sandbox.providerPath,
    "--provider", "openai",
    "--model", "gpt-5.6-sol",
  ], {
    cwd: sandbox.cwd,
    env: isolatedEnvironment(sandbox.home, sandbox.agentDir, sandbox.sessionDir),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  const result = await new Promise((resolveRun, rejectRun) => {
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL")
      rejectRun(new Error("eval smoke timed out after 120000ms"))
    }, 120_000)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
      if (stdout.includes('"type":"agent_settled"')) child.stdin.end()
    })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8") })
    child.once("error", (error) => {
      clearTimeout(watchdog)
      rejectRun(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(watchdog)
      resolveRun({ code, signal })
    })
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Run the JavaScript eval smoke." })}\n`)
  })
  return { ...result, stderr }
}

function readEvalResult(sessionDir) {
  const records = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(sessionDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return records
    .filter((record) => record?.type === "message")
    .map((record) => record.message)
    .find((message) => message?.role === "toolResult" && message.toolName === "eval")
}

async function main() {
  const { binary } = parseArgs(process.argv.slice(2))
  const sandbox = createSandbox()
  try {
    const result = await drive(binary, sandbox)
    if (result.code !== 0) {
      throw new Error(`binary exited code=${result.code} signal=${result.signal}\n${result.stderr.slice(-4000)}`)
    }
    const evalResult = readEvalResult(sandbox.sessionDir)
    if (evalResult === undefined) throw new Error("eval tool produced no result")
    const evalText = Array.isArray(evalResult.content)
      ? evalResult.content.map((part) => part?.type === "text" ? part.text : "").join("\n")
      : ""
    if (evalResult.isError === true || !evalText.split(/\s+/).includes("42")) {
      const extensionWarning = result.stderr.split("\n").find((line) => line.includes("Failed to load extension"))
      const extensionCause = extensionWarning?.match(/Failed to load extension .*?: (.*)$/)?.[1]
      throw new Error(
        `eval did not return 42: ${evalText}${extensionCause === undefined ? "" : `\nextension load failed: ${extensionCause}`}`,
      )
    }
    process.stdout.write("PASS eval registered and JavaScript cell returned 42\n")
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
