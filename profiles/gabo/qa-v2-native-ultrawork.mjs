#!/usr/bin/env node
/**
 * Runs the actual disposable V2 delegation contract in its explicit-keyword
 * mode. Keeping this as a thin verifier prevents this QA from reading the
 * user's V1 config merely to borrow a provider/model.
 */
import childProcess from "node:child_process"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const evidence = path.join(root, ".omo/evidence/20261002-rigel-v2-native-ultrawork")
const delegatedContract = path.join(root, "profiles/gabo/qa-v2-native-delegation.mjs")

function save(name, value) {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidence, name), value, { mode: 0o600 })
}

const result = childProcess.spawnSync(process.execPath, [delegatedContract], {
  cwd: root,
  env: { ...buildIsolatedV2Env({ sandbox: fs.mkdtempSync(path.join(os.tmpdir(), "rigel-ultrawork-")) }), RIGEL_QA_EXPLICIT_ULTRAWORKER: "1" },
  encoding: "utf8",
  timeout: 60_000,
})
const transcript = [`exit=${result.status}; signal=${result.signal}`, result.stdout ?? "", result.stderr ?? ""].join("\n")
save("native-ultrawork.txt", transcript)
const runtimeLoaded = transcript.includes("Native runtime loaded: yes.")
const reached = transcript.includes("Explicit `Ultraworker` keyword reached the root model request: yes.")
const childIsolated = transcript.includes("Default Ultrawork stayed out of the child: yes.")
const report = [
  "# Oh My Rigel — native V2 Ultrawork keyword contract",
  "",
  `- Real isolated V2 server: ${result.status === 0 ? "yes" : "no"}.`,
  `- Native runtime loaded: ${runtimeLoaded ? "yes" : "no"}.`,
  `- Explicit \`Ultraworker\` reached the root provider request: ${reached ? "yes" : "no"}.`,
  `- Native Ultrawork stayed out of child context: ${childIsolated ? "yes" : "no"}.`,
  "- V1 configuration read: no.",
  "",
].join("\n")
save("validation.md", report)
process.stdout.write(report)
if (result.status !== 0 || !runtimeLoaded || !reached || !childIsolated) process.exitCode = 1
