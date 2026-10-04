#!/usr/bin/env node
/**
 * Loads the Rigel V2 plugin through a real isolated OpenCode V2 process.
 * It intentionally accepts a provider failure after startup: this QA proves
 * plugin registration, not a paid/model-authenticated completion.
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = "/home/gabodev/.opencode/bin/opencode"
// The V1 configuration is intentionally never a QA input.  This probe must
// exercise the isolated V2 lab contract it claims to validate.
const liveConfig = process.env.RIGEL_V2_LAB_CONFIG || "/home/gabodev/.local/share/opencode-v2-lab/config/opencode/opencode.json"
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261001-rigel-v2-runtime-bridge")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-qa-"))
const configHome = path.join(temp, "config")
const home = path.join(temp, "home")
const runtime = path.join(temp, "plugin")
const delegation = process.argv.includes("--delegation")

function cleanup() { fs.rmSync(temp, { recursive: true, force: true }) }
function writeEvidence(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const live = JSON.parse(fs.readFileSync(liveConfig, "utf8"))
  const agent = live.agent?.["Sisyphus - ultraworker"] ?? { mode: "primary", model: live.model }
  const explore = live.agent?.explore ?? { mode: "subagent", model: live.small_model ?? live.model }
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const distEntry = `file://${path.join(sourceRoot, "dist/index.js")}`
  const adapter = fs.readFileSync(path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter.mjs"), "utf8")
    .replaceAll("__OMO_DIST_ENTRY__", distEntry)
  fs.writeFileSync(path.join(runtime, "index.js"), adapter, { mode: 0o600 })
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/omo-v2-adapter-core.mjs"), path.join(runtime, "omo-v2-adapter-core.mjs"))

  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    model: live.model,
    small_model: live.small_model,
    provider: live.provider,
    plugins: live.plugins,
    plugin: [runtime],
    // The host's native `subagent` is intentionally disabled only in this
    // sandbox so the model must exercise OmO's legacy `task` tool. Production
    // keeps both tools available.
    ...(delegation ? { tools: { subagent: false } } : {}),
    default_agent: "Sisyphus - ultraworker",
    agent: delegation
      ? { ...(live.agent ?? {}), "Sisyphus - ultraworker": agent, explore }
      : { "Sisyphus - ultraworker": agent },
  }, null, 2) + "\n", { mode: 0o600 })

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(temp, "data"),
    XDG_STATE_HOME: path.join(temp, "state"),
    XDG_CACHE_HOME: path.join(temp, "cache"),
  }
  const prompt = delegation
    ? "Prueba de delegación aislada. Usa la herramienta task exactamente una vez con run_in_background=true para pedir a explore que liste los archivos de primer nivel de este repositorio. No esperes el resultado; después de lanzar la tarea responde exactamente RIGEL_V2_TASK_OK. No edites archivos."
    : "Reply only: RIGEL_V2_QA_OK"
  const result = childProcess.spawnSync(binary, [
    "--print-logs", "--log-level", "debug", "run", "--standalone", "--format", "json", "--agent", "Sisyphus - ultraworker", prompt,
  // Keep the non-delegation contract below the interactive QA runner's
  // 30-second ceiling so it always writes evidence, even if a provider hangs.
  ], { cwd: sourceRoot, env, encoding: "utf8", timeout: delegation ? 60_000 : 25_000 })
  const transcript = [
    `exit=${result.status}; signal=${result.signal}; error=${result.error?.message ?? ""}`,
    "--- stdout ---", result.stdout ?? "",
    "--- stderr ---", result.stderr ?? "",
  ].join("\n")
  const transcriptName = delegation ? "runtime-delegation.txt" : "runtime-load.txt"
  writeEvidence(transcriptName, transcript)
  const loaded = transcript.includes("[oh-my-rigel] OpenCode V2 bridge active:")
  const registered = /OpenCode V2 bridge active: (?:1[0-9]|[2-9][0-9]) tools/.test(transcript)
  const forbidden = /Cannot find module|ERR_MODULE_NOT_FOUND|unknown plugin API|failed to load plugin|disabled plugin after transform failure/i.test(transcript)
  const replied = transcript.includes(delegation ? "RIGEL_V2_TASK_OK" : "RIGEL_V2_QA_OK")
  const usedTask = !delegation || /"tool":"task"|tool=task|name=task/.test(transcript)
  const resolvedTask = !delegation || (replied && usedTask && !/Unknown agent:\s*"explore"/i.test(transcript))
  const report = [
    `# Oh My Rigel — QA de bridge V2${delegation ? " (delegación)" : ""}`,
    "",
    "- Superficie: proceso real `opencode run --standalone` con HOME/XDG temporal.",
    `- Plugin cargado: ${loaded ? "sí" : "no"}.`,
    `- Herramientas registradas: ${registered ? "sí" : "no"}.`,
    `- Respuesta de modelo esperada: ${replied ? "sí" : "no"}.`,
    `- Herramienta task observada: ${delegation ? (usedTask ? "sí" : "no") : "no aplica"}.`,
    `- Delegación por nombre resuelta: ${delegation ? (resolvedTask ? "sí" : "no") : "no aplica"}.`,
    `- Error de carga/contrato V2: ${forbidden ? "sí" : "no"}.`,
    `- Directorio temporal eliminado: ${temp} (al cerrar el script).`,
    "- Las credenciales y la base de sesiones permanecen fuera del sandbox; la ejecución usa solamente configuración temporal y plugins instalados del host.",
    `- Transcripción sanitizada: ${transcriptName}`,
  ].join("\n") + "\n"
  writeEvidence("validation.md", report)
  process.stdout.write(report)
  // Loading/registration is this probe's contract. Only a delegation run
  // additionally requires a provider response and task lifecycle evidence.
  const requiredReply = delegation ? replied : true
  if (!loaded || !registered || !requiredReply || !usedTask || !resolvedTask || forbidden) process.exitCode = 1
} finally {
  cleanup()
}
