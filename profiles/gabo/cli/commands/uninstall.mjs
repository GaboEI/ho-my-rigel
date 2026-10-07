// Rigel V2 CLI `uninstall` (alias `cleanup`).
//
// The opencode platform performs a REAL V2 uninstall of this fork: it removes
// the staged runtime plugin entry from the isolated V2 config and deletes the
// staged runtime + activation state. It refuses when the config does not
// register the staged runtime, and it NEVER touches the V1 config
// (~/.config/opencode). The codex and native platforms delegate to the real
// adapter uninstallers.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import * as codexInstall from "@oh-my-opencode/omo-codex/install"
import * as senpiInstall from "@oh-my-opencode/omo-senpi/install"

import { fail, parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

const PLATFORMS = ["opencode", "codex", "native", "both"]

function labRoot(io) {
  return io.env.RIGEL_V2_LAB_ROOT ?? path.join(io.home, ".local", "share", "opencode-v2-lab")
}

function configFile(io) {
  return io.env.RIGEL_V2_CONFIG ?? path.join(labRoot(io), "config", "opencode", "opencode.json")
}

function runtimeDir(io) {
  return path.join(labRoot(io), "rigel", "runtime", "rigel-v2-native")
}

function stateFile(io) {
  return path.join(labRoot(io), "rigel", "active-trial.json")
}

function plan(io, platform, codexHome) {
  const steps = []
  if (platform === "opencode" || platform === "both") {
    steps.push(
      { kind: "unregister-runtime", config: configFile(io), entry: runtimeDir(io) },
      { kind: "remove-runtime", path: runtimeDir(io) },
      { kind: "remove-state", path: stateFile(io) },
    )
  }
  if (platform === "codex" || platform === "both") steps.push({ kind: "codex-cleanup", codexHome })
  if (platform === "native") steps.push({ kind: "senpi-uninstall", homeDir: io.home })
  return steps
}

function uninstallOpencode(io, dryRun) {
  const config = configFile(io)
  const entry = runtimeDir(io)
  if (!existsSync(config)) return { ok: true, skipped: "no isolated V2 config found" }
  let document
  try {
    document = JSON.parse(readFileSync(config, "utf8"))
  } catch (error) {
    return { ok: false, error: `could not parse ${config}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const plugins = Array.isArray(document.plugin) ? document.plugin : []
  if (!plugins.includes(entry)) {
    return { ok: false, error: `the V2 config does not register the staged runtime (${entry}); refusing to uninstall` }
  }
  if (dryRun) return { ok: true, dryRun: true, wouldRemove: entry }
  document.plugin = plugins.filter((plugin) => plugin !== entry)
  writeFileSync(config, `${JSON.stringify(document, null, 2)}\n`)
  rmSync(runtimeDir(io), { recursive: true, force: true })
  rmSync(stateFile(io), { force: true })
  return { ok: true, removed: entry }
}

export const uninstallCommand = {
  name: "uninstall",
  aliases: ["cleanup"],
  summary: "Uninstall the Rigel V2 surface for a platform",
  usage: "rigel-v2 uninstall [--platform opencode|codex|native|both] [--dry-run] [--json] [--codex-home <dir>] [--home <dir>]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const platform = options.platform === undefined ? "opencode" : String(options.platform)
    if (!PLATFORMS.includes(platform)) {
      return fail(io, `Unknown platform: ${platform}. Expected one of ${PLATFORMS.join(", ")}`)
    }
    const dryRun = options["dry-run"] === true
    const codexHome = options["codex-home"] === undefined
      ? io.env.CODEX_HOME ?? path.join(io.home, ".codex")
      : String(options["codex-home"])

    if (dryRun) {
      const steps = plan(io, platform, codexHome)
      if (options.json === true) {
        writeJson(io, { ok: true, platform, dryRun: true, steps })
        return 0
      }
      io.stdout.write(`Uninstall plan for platform ${platform}:\n`)
      for (const step of steps) io.stdout.write(`- ${step.kind}${step.path ? ` ${step.path}` : ""}\n`)
      return 0
    }

    const results = {}
    if (platform === "opencode" || platform === "both") {
      const result = uninstallOpencode(io, dryRun)
      results.opencode = result
      if (!result.ok) return fail(io, result.error)
    }
    if (platform === "codex" || platform === "both") {
      const adapter = io.codexInstall ?? codexInstall
      results.codex = await adapter.cleanupCodexLight({ codexHome })
    }
    if (platform === "native") {
      const adapter = io.senpiInstall ?? senpiInstall
      results.native = await adapter.runSenpiUninstaller({ homeDir: io.home })
    }

    if (options.json === true) {
      writeJson(io, { ok: true, platform, results })
      return 0
    }
    io.stdout.write(`Uninstalled platform ${platform}.\n`)
    return 0
  },
}
