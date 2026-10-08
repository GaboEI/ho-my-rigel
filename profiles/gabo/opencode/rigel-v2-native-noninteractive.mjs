/**
 * Native V2 equivalent of V1's non-interactive environment guard for shell.
 *
 * Ported from `packages/omo-opencode/src/hooks/non-interactive-env/` and
 * `packages/omo-opencode/src/shared/shell-env.ts`:
 * - Detects the executing shell type (unix / csh / powershell / cmd) and
 *   builds the matching env prefix (`export ...;`, `setenv ...;`,
 *   `$env:...;`, `set ... &&`).
 * - On a banned interactive command, V1 attaches a warning message and lets
 *   the call proceed. V2's execute.before cannot attach a message, so the
 *   equivalent observable behavior here rewrites the command to print the
 *   same warning instead of hanging the non-interactive session on the
 *   interactive program.
 */

import { patchToolArgs } from "./rigel-v2-native-tool-args.mjs"

export const NON_INTERACTIVE_ENV = {
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  HOMEBREW_NO_AUTO_UPDATE: "1",
  GIT_EDITOR: ":",
  EDITOR: ":",
  VISUAL: "",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_PAGER: "cat",
  PAGER: "cat",
  npm_config_yes: "true",
  PIP_NO_INPUT: "1",
  YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
}

// V1's banned list minus the parenthesized REPL entries (V1 filters those
// out of its regex set, so bare `python`/`node` calls are never banned there).
export const BANNED_COMMANDS = ["vim", "nano", "vi", "emacs", "less", "more", "man", "git add -p", "git rebase -i"]

function shellEscape(value, shellType) {
  if (value === "") return shellType === "cmd" ? '""' : "''"
  switch (shellType) {
    case "unix":
    case "csh":
      if (/[^a-zA-Z0-9_\-.:/]/.test(value)) return `'${value.replace(/'/g, "'\\''")}'`
      return value
    case "powershell":
      return `'${value.replace(/'/g, "''")}'`
    case "cmd":
      return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`
    default:
      return value
  }
}

export function detectShellType(platform = process.platform, env = process.env) {
  if (env.SHELL) {
    if (env.SHELL.includes("csh") || env.SHELL.includes("tcsh")) return "csh"
    return "unix"
  }
  if (platform === "win32" && (env.BASH_VERSION || env.MSYSTEM || env.WSL_DISTRO_NAME)) return "unix"
  if (env.PSModulePath) return "powershell"
  return platform === "win32" ? "cmd" : "unix"
}

function detectWindowsShellType(shellPath) {
  if (!shellPath) return undefined
  const shellName = shellPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase()
  if (shellName === "cmd" || shellName === "cmd.exe") return "cmd"
  if (shellName === "powershell" || shellName === "powershell.exe" || shellName === "pwsh" || shellName === "pwsh.exe") return "powershell"
  return undefined
}

// OpenCode on Windows runs the shell tool through a Windows shell
// (PowerShell by default, cmd as user-overridable fallback), regardless of
// MSYSTEM or a Unix-shaped SHELL value from Git Bash. See upstream #3607.
export function detectCommandShellType(platform = process.platform, env = process.env) {
  if (platform !== "win32") return detectShellType(platform, env)
  const fromShell = detectWindowsShellType(env.SHELL)
  if (fromShell) return fromShell
  if (!env.SHELL && !env.MSYSTEM) {
    const fromComSpec = detectWindowsShellType(env.ComSpec)
    if (fromComSpec) return fromComSpec
    return "cmd"
  }
  return "powershell"
}

export function buildEnvPrefix(env = NON_INTERACTIVE_ENV, shellType = "unix") {
  const entries = Object.entries(env)
  if (entries.length === 0) return ""
  switch (shellType) {
    case "unix": {
      const assignments = entries.map(([key, value]) => `${key}=${shellEscape(value, shellType)}`).join(" ")
      return `export ${assignments};`
    }
    case "csh": {
      const assignments = entries.map(([key, value]) => `setenv ${key} ${shellEscape(value, shellType)}`).join("; ")
      return `${assignments};`
    }
    case "powershell": {
      const assignments = entries.map(([key, value]) => `$env:${key}=${shellEscape(value, shellType)}`).join("; ")
      return `${assignments};`
    }
    case "cmd": {
      const assignments = entries.map(([key, value]) => `set ${key}=${shellEscape(value, shellType)}`).join(" && ")
      return `${assignments} &&`
    }
    default:
      return ""
  }
}

function commandArgument(event) {
  const input = event?.input ?? event?.args ?? {}
  const value = input.command ?? input.cmd
  return typeof value === "string" && value.trim() ? value : undefined
}

function detectBannedCommand(command) {
  for (const candidate of BANNED_COMMANDS) {
    if (new RegExp(`(^|[;&|\\s])${candidate.replace(/ /g, "\\s+")}(?=$|[;&|\\s])`, "i").test(command)) return candidate
  }
  return undefined
}

export function warningMessage(bannedCommand) {
  return `Warning: '${bannedCommand}' is an interactive command that may hang in non-interactive environments.`
}

/** Native V2 equivalent of V1's non-interactive environment guard for shell. */
export function createNativeNonInteractiveEnvGuard(context = {}) {
  const shellType = context.shellType ?? detectCommandShellType()
  const envPrefix = context.envPrefix ?? buildEnvPrefix(NON_INTERACTIVE_ENV, shellType)
  return {
    before(event) {
      // V1 names this builtin `bash`; the native V2 catalog names it `shell`.
      if (String(event?.tool ?? "").toLowerCase() !== "shell") return
      const command = commandArgument(event)
      if (!command) return
      const banned = detectBannedCommand(command)
      if (banned) {
        const message = warningMessage(banned)
        patchToolArgs(event, (args) => {
          if (Object.hasOwn(args, "command")) args.command = `echo ${JSON.stringify(message)}`
          else if (Object.hasOwn(args, "cmd")) args.cmd = `echo ${JSON.stringify(message)}`
        })
        return
      }
      if (!/\bgit\b/i.test(command) || command.trim().startsWith(envPrefix.trim())) return
      patchToolArgs(event, (args) => {
        if (Object.hasOwn(args, "command")) args.command = `${envPrefix} ${command}`
        else if (Object.hasOwn(args, "cmd")) args.cmd = `${envPrefix} ${command}`
      })
    },
  }
}
