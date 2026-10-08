// Rigel V2 CLI `get-local-version`.
//
// Reports the running Rigel V2 version against the published version. It reuses
// the pure primitives of the native OpenCode V2 update core
// (`../../opencode/rigel-v2-native-update-core.mjs`) so this CLI and the runtime
// auto-update checker can never disagree about channel extraction or version
// ordering. The network is injected through `io.fetch`, so the command is
// hermetic in tests and never launches OpenCode.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  compareSemverVersions,
  extractChannel,
  resolveLatestForChannel,
} from "../../opencode/rigel-v2-native-update-core.mjs"
import { parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const PRODUCT_NAME = "oh-my-rigel"
const DEFAULT_PACKAGE = "oh-my-openagent"
const DEFAULT_REGISTRY_ORIGIN = "https://registry.npmjs.org/-/package/"
const FETCH_TIMEOUT_MS = 5000

function resolveRepoRoot(io) {
  const injected = io?.env?.RIGEL_V2_REPO_ROOT
  if (typeof injected === "string" && injected) return injected
  return process.env.RIGEL_V2_REPO_ROOT ?? REPO_ROOT
}

/** Read `version` from the repository package.json; a read failure is not a crash. */
function readCurrentVersion(io) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(resolveRepoRoot(io), "package.json"), "utf8"))
    return typeof pkg.version === "string" ? pkg.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function resolveRegistryUrl(options, env) {
  if (typeof options.registry === "string" && options.registry) return options.registry
  if (typeof env.RIGEL_UPDATE_REGISTRY_URL === "string" && env.RIGEL_UPDATE_REGISTRY_URL) {
    return env.RIGEL_UPDATE_REGISTRY_URL
  }
  const packageName = typeof env.RIGEL_UPDATE_PACKAGE === "string" && env.RIGEL_UPDATE_PACKAGE
    ? env.RIGEL_UPDATE_PACKAGE
    : DEFAULT_PACKAGE
  return `${DEFAULT_REGISTRY_ORIGIN}${packageName}/dist-tags`
}

function classifyStatus(currentVersion, latestVersion) {
  if (typeof latestVersion !== "string" || latestVersion === "") return "unknown"
  const comparison = compareSemverVersions(currentVersion, latestVersion)
  if (comparison === null) return "unknown"
  return comparison === -1 ? "outdated" : "up-to-date"
}

function render(io, result, json) {
  if (json) {
    writeJson(io, result)
    return
  }
  io.stdout.write(`${PRODUCT_NAME} ${result.currentVersion} (latest: ${result.latestVersion ?? "unknown"})\n`)
}

export const getLocalVersionCommand = {
  name: "get-local-version",
  summary: "Report the running Rigel V2 version against the published version",
  usage: "rigel-v2 get-local-version [--registry <url>] [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const env = io?.env ?? process.env
    const json = options.json === true
    const currentVersion = readCurrentVersion(io)
    const channel = extractChannel(currentVersion)
    const result = { currentVersion, latestVersion: null, isUpToDate: false, channel, status: "unknown" }

    if (typeof io.fetch !== "function") {
      render(io, result, json)
      return 1
    }

    try {
      const response = await io.fetch(resolveRegistryUrl(options, env), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response && response.ok === false) {
        throw new Error(`registry responded ${response.status ?? "not ok"}`)
      }
      const distTags = await response.json()
      const latestVersion = resolveLatestForChannel(distTags, channel)
      result.latestVersion = typeof latestVersion === "string" ? latestVersion : null
      result.status = classifyStatus(currentVersion, result.latestVersion)
      result.isUpToDate = result.status === "up-to-date"
    } catch {
      result.latestVersion = null
      result.isUpToDate = false
      result.status = "error"
    }

    render(io, result, json)
    return result.status === "up-to-date" || result.status === "outdated" ? 0 : 1
  },
}
