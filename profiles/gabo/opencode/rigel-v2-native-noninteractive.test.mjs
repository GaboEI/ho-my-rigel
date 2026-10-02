import { describe, expect, test } from "bun:test"
import {
  createNativeNonInteractiveEnvGuard,
  buildEnvPrefix,
  detectCommandShellType,
  detectShellType,
  NON_INTERACTIVE_ENV,
  warningMessage,
} from "./rigel-v2-native-noninteractive.mjs"

function event(command) { return { tool: "shell", input: { command } } }
const prefix = buildEnvPrefix()

describe("native V2 non-interactive environment guard", () => {
  test("prefixes git commands once with the v1 unix prefix", () => {
    const value = event("git status --short")
    createNativeNonInteractiveEnvGuard().before(value)
    expect(value.input.command).toBe(`${prefix} git status --short`)
    createNativeNonInteractiveEnvGuard().before(value)
    expect(value.input.command).toBe(`${prefix} git status --short`)
  })

  test("prefix is idempotent-checked against its own trimmed text", () => {
    const value = event(`${prefix.trim()} git push`)
    createNativeNonInteractiveEnvGuard().before(value)
    expect(value.input.command).toBe(`${prefix.trim()} git push`)
  })

  test("does not rewrite unrelated commands", () => {
    const value = event("rg --files")
    createNativeNonInteractiveEnvGuard().before(value)
    expect(value.input.command).toBe("rg --files")
  })

  test("warns instead of throwing on a banned interactive command", () => {
    const value = event("git rebase -i HEAD~1")
    createNativeNonInteractiveEnvGuard().before(value)
    expect(value.input.command).toBe(`echo ${JSON.stringify(warningMessage("git rebase -i"))}`)
  })

  test("warning echoes the v1 message for editors and pagers", () => {
    for (const banned of ["vim", "less", "man"]) {
      const value = event(`${banned} file`)
      createNativeNonInteractiveEnvGuard().before(value)
      expect(value.input.command).toBe(`echo ${JSON.stringify(warningMessage(banned))}`)
    }
  })

  test("bare python/node repl calls are not banned, matching v1's pattern filter", () => {
    const value = event("python --version")
    createNativeNonInteractiveEnvGuard().before(value)
    expect(value.input.command).toBe("python --version")
  })
})

describe("shell detection and env prefix", () => {
  test("unix detection from SHELL and csh variant", () => {
    expect(detectCommandShellType("linux", { SHELL: "/bin/bash" })).toBe("unix")
    expect(detectShellType("linux", { SHELL: "/bin/tcsh" })).toBe("csh")
  })

  test("windows maps explicit shells; unrecognized SHELL wins over MSYSTEM like v1 #3607", () => {
    expect(detectCommandShellType("win32", { SHELL: "C:\\powershell.exe" })).toBe("powershell")
    expect(detectCommandShellType("win32", { ComSpec: "C:\\cmd.exe" })).toBe("cmd")
    // Upstream quirk preserved: detectCommandShellType checks SHELL against
    // Windows shells first and only falls to ComSpec/default when SHELL is
    // unset, so a Unix-shaped SHELL plus MSYSTEM still resolves powershell.
    expect(detectCommandShellType("win32", { SHELL: "/usr/bin/bash", MSYSTEM: "MINGW64" })).toBe("powershell")
    expect(detectShellType("win32", { SHELL: "", MSYSTEM: "MINGW64" })).toBe("unix")
    expect(detectCommandShellType("win32", {})).toBe("cmd")
  })

  test("buildEnvPrefix emits each shell syntax", () => {
    const env = { CI: "true" }
    expect(buildEnvPrefix(env, "unix")).toBe("export CI=true;")
    expect(buildEnvPrefix(env, "csh")).toBe("setenv CI true;")
    expect(buildEnvPrefix(env, "powershell")).toBe("$env:CI='true';")
    expect(buildEnvPrefix(env, "cmd")).toBe("set CI=\"true\" &&")
  })

  test("non-interactive env matches the v1 table", () => {
    expect(Object.keys(NON_INTERACTIVE_ENV).sort()).toEqual([
      "CI", "DEBIAN_FRONTEND", "EDITOR", "GCM_INTERACTIVE", "GIT_EDITOR", "GIT_MERGE_AUTOEDIT",
      "GIT_PAGER", "GIT_SEQUENCE_EDITOR", "GIT_TERMINAL_PROMPT", "HOMEBREW_NO_AUTO_UPDATE",
      "PAGER", "PIP_NO_INPUT", "VISUAL", "YARN_ENABLE_IMMUTABLE_INSTALLS", "npm_config_yes",
    ].sort())
  })
})
