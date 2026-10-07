// Rigel V2 CLI `ast-grep`.
//
// Provisions the `sg` binary the ast-grep skill consumes, delegating the actual
// download/build to the real utils installer. The V2 fork does not bundle the
// ast-grep skill, so this command makes the provisioning reachable as a real
// user command (dry-run shows the target) instead of an orphan installer.
import path from "node:path"

import { sharedSkillsRootPath } from "@oh-my-opencode/shared-skills"
import { astGrepRuntimeDir, runAstGrepSkillInstall } from "@oh-my-opencode/utils"

import { fail, parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

function describeResult(result) {
  if (result?.kind === "succeeded") return null
  if (result?.kind === "timed-out") return "timed out after 30s"
  if (typeof result?.reason === "string" && result.reason.length > 0) return result.reason
  return typeof result?.kind === "string" ? result.kind : "unknown failure"
}

export const astGrepCommand = {
  name: "ast-grep",
  summary: "Provision the sg binary for the ast-grep skill",
  usage: "rigel-v2 ast-grep [--home <dir>] [--platform <p>] [--arch <a>] [--skill-dir <d>] [--dry-run] [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const platform = options.platform !== undefined ? String(options.platform) : process.platform
    const arch = options.arch !== undefined ? String(options.arch) : process.arch
    const home = options.home !== undefined ? String(options.home) : io.home
    const baseDir = path.join(home, ".omo")
    const targetDir = astGrepRuntimeDir(baseDir, platform, arch)
    const skillDir = options["skill-dir"] !== undefined
      ? String(options["skill-dir"])
      : path.join(sharedSkillsRootPath(), "ast-grep")

    if (options["dry-run"] === true) {
      const plan = { platform, arch, targetDir, skillDir }
      if (options.json === true) writeJson(io, { ok: true, dryRun: true, ...plan })
      else io.stdout.write(`ast-grep sg would be provisioned into ${targetDir} from ${skillDir}\n`)
      return 0
    }

    const installer = io.astGrepInstall ?? runAstGrepSkillInstall
    const result = await installer({ platform, skillDir, targetDir })
    const failure = describeResult(result)
    if (failure !== null) return fail(io, `sg provisioning skipped: ${failure}`)

    if (options.json === true) writeJson(io, { ok: true, targetDir })
    else io.stdout.write(`sg provisioned into ${targetDir}\n`)
    return 0
  },
}
