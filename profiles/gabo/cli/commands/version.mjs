// Rigel V2 CLI `version`.
//
// The version is read from the repository package.json so the shipped command
// surface, the plugin bundle and the release tags cannot drift apart. The
// product label is the fork identity ("oh-my-rigel"), not the upstream package
// name, because this CLI is the entry the fork distributes.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

const REPO_ROOT = process.env.RIGEL_V2_REPO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const PRODUCT_NAME = "oh-my-rigel"

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"))
  return typeof pkg.version === "string" ? pkg.version : "0.0.0"
}

export const versionCommand = {
  name: "version",
  summary: "Print the Rigel V2 product version",
  usage: "rigel-v2 version [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const version = readPackageVersion()
    if (options.json === true) {
      writeJson(io, { name: PRODUCT_NAME, version })
      return 0
    }
    io.stdout.write(`${PRODUCT_NAME} v${version}\n`)
    return 0
  },
}
