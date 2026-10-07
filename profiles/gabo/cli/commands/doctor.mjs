// Rigel V2 CLI `doctor`.
//
// Drives the real profile validator through the injectable spawn so the health
// surface of this fork has a single source of truth: the same contract a future
// installer enforces at activation time. It never launches OpenCode.
import path from "node:path"
import { fileURLToPath } from "node:url"

import { exitCodeOf, parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

const REPO_ROOT = process.env.RIGEL_V2_REPO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

export const doctorCommand = {
  name: "doctor",
  summary: "Validate the Rigel V2 profile contract",
  usage: "rigel-v2 doctor [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const script = path.join(REPO_ROOT, "profiles", "gabo", "validate-profile.mjs")
    const result = io.spawn("node", [script], { cwd: REPO_ROOT, encoding: "utf8" })
    const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`
    const ok = exitCodeOf(result) === 0
    if (options.json === true) {
      writeJson(io, { ok, output })
      return ok ? 0 : 1
    }
    if (ok) {
      io.stdout.write("Rigel V2 profile OK\n")
      return 0
    }
    if (output.length > 0) io.stdout.write(output)
    return 1
  },
}
