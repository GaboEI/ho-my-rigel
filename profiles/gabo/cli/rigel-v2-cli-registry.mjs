// Registry of the Rigel V2 CLI commands. Each module exports a command object
// `{ name, aliases?, summary, usage, run(argv, io) -> Promise<number> }`.
import { astGrepCommand } from "./commands/ast-grep.mjs"
import { boulderCommand } from "./commands/boulder.mjs"
import { doctorCommand } from "./commands/doctor.mjs"
import { getLocalVersionCommand } from "./commands/get-local-version.mjs"
import { installCommand } from "./commands/install.mjs"
import { refreshModelCapabilitiesCommand } from "./commands/refresh-model-capabilities.mjs"
import { ulwLoopCommand } from "./commands/ulw-loop.mjs"
import { uninstallCommand } from "./commands/uninstall.mjs"
import { versionCommand } from "./commands/version.mjs"
import { worktreeSweepCommand } from "./commands/worktree-sweep.mjs"

export const COMMANDS = Object.freeze([
  versionCommand,
  getLocalVersionCommand,
  doctorCommand,
  installCommand,
  uninstallCommand,
  ulwLoopCommand,
  worktreeSweepCommand,
  boulderCommand,
  refreshModelCapabilitiesCommand,
  astGrepCommand,
])
