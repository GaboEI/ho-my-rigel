import { describe, expect, test } from "bun:test"
import {
  buildBlockedTmuxCommandMessage,
  buildProhibitedTmuxCommandMessage,
  classifyTmuxCommand,
  createInteractiveBashTool,
  createPtyCommandRunner,
  detectTmuxAvailability,
  findExecutableOnPath,
  findSubcommandIndex,
  INTERACTIVE_BASH_TOOL_NAME,
  tokenizeCommand,
} from "./interactive-bash.tools.mjs"

describe("interactive_bash tokenizer and subcommand resolution", () => {
  test("tokenizes quoted and escaped arguments like the V1 tool", () => {
    expect(tokenizeCommand('send-keys -t omo-dev "vim file" Enter')).toEqual(["send-keys", "-t", "omo-dev", "vim file", "Enter"])
    expect(tokenizeCommand("new-session -d -s 'my session'")).toEqual(["new-session", "-d", "-s", "my session"])
    expect(tokenizeCommand("send-keys -t s hello\\ world")).toEqual(["send-keys", "-t", "s", "hello world"])
  })

  test("finds the subcommand past global options that take an argument", () => {
    expect(findSubcommandIndex(["-L", "demo", "kill-server"])).toBe(2)
    expect(findSubcommandIndex(["-f", "/tmp/x.conf", "list-sessions"])).toBe(2)
    expect(findSubcommandIndex(["--", "kill-server"])).toBe(1)
  })

  test("classifies prohibited and blocked subcommands case-insensitively", () => {
    expect(classifyTmuxCommand(["-L", "demo", "KILL-SERVER"])).toEqual({ kind: "prohibited", rawSubcommand: "KILL-SERVER" })
    expect(classifyTmuxCommand(["capture-pane", "-p"])).toEqual({ kind: "blocked", rawSubcommand: "capture-pane" })
    expect(classifyTmuxCommand(["send-keys", "-t", "s", "ls", "Enter"])).toEqual({ kind: "allowed", rawSubcommand: "send-keys" })
  })

  test("blocked message points at Bash and names the target session", () => {
    const message = buildBlockedTmuxCommandMessage("capture-pane", ["capture-pane", "-t", "omo-dev"])
    expect(message).toContain("Error: 'capture-pane' is blocked in interactive_bash.")
    expect(message).toContain("tmux capture-pane -p -t omo-dev")
    expect(message).toContain("Do NOT retry with interactive_bash.")
  })

  test("prohibited message forbids kill-server", () => {
    expect(buildProhibitedTmuxCommandMessage("kill-server")).toContain("NEVER EVER run tmux kill-server from interactive_bash.")
  })
})

describe("interactive_bash tool execution", () => {
  function toolWithRunner(runner) {
    return createInteractiveBashTool({ runner, tmuxPath: "/usr/bin/tmux" })
  }

  test("rejects an empty command before running anything", async () => {
    let calls = 0
    const tool = toolWithRunner({ run: async () => { calls++; return { stdout: "", stderr: "", exitCode: 0 } } })
    expect(await tool.execute({ tmux_command: "   " })).toBe("Error: Empty tmux command")
    expect(calls).toBe(0)
  })

  test("returns the strong prohibition for kill-server without invoking the runner", async () => {
    let calls = 0
    const tool = toolWithRunner({ run: async () => { calls++; return { stdout: "", stderr: "", exitCode: 0 } } })
    const output = await tool.execute({ tmux_command: "-L omo-socket kill-server" })
    expect(output).toContain("Error: 'kill-server' is prohibited in interactive_bash.")
    expect(calls).toBe(0)
  })

  test("returns the blocked message for capture-pane without invoking the runner", async () => {
    const tool = toolWithRunner({ run: async () => ({ stdout: "should not run", stderr: "", exitCode: 0 }) })
    const output = await tool.execute({ tmux_command: "capture-pane -t omo-dev" })
    expect(output).toContain("'capture-pane' is blocked")
  })

  test("passes the tmux path and tokenized args to the V2 runner and returns stdout", async () => {
    const calls = []
    const tool = toolWithRunner({ run: async (input) => { calls.push(input); return { stdout: "session-1\n", stderr: "", exitCode: 0 } } })
    expect(await tool.execute({ tmux_command: "list-sessions" })).toBe("session-1\n")
    expect(calls).toEqual([{ command: "/usr/bin/tmux", args: ["list-sessions"], timeoutMs: 60000 }])
  })

  test("returns (no output) for an empty successful result", async () => {
    const tool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) })
    expect(await tool.execute({ tmux_command: "new-session -d -s s" })).toBe("(no output)")
  })

  test("formats a non-zero exit like V1: stderr first, exit code fallback", async () => {
    const stderrTool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "no server running\n", exitCode: 1 }) })
    expect(await stderrTool.execute({ tmux_command: "list-sessions" })).toBe("Error: no server running")
    const bareTool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "", exitCode: 3 }) })
    expect(await bareTool.execute({ tmux_command: "list-sessions" })).toBe("Error: Command failed with exit code 3")
  })

  test("surfaces a runner failure as a V1-style Error string", async () => {
    const tool = toolWithRunner({ run: async () => { throw new Error("Timeout after 60000ms") } })
    expect(await tool.execute({ tmux_command: "list-sessions" })).toBe("Error: Timeout after 60000ms")
  })

  test("exposes the V1 tool name and JSON Schema input", () => {
    const tool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) })
    expect(tool.name).toBe(INTERACTIVE_BASH_TOOL_NAME)
    expect(tool.input.required).toEqual(["tmux_command"])
  })
})

describe("tmux availability gate", () => {
  test("finds an executable on PATH without spawning", () => {
    const found = findExecutableOnPath({
      command: "tmux",
      env: { PATH: "/usr/bin:/opt/bin" },
      platform: "linux",
      isFile: (candidate) => candidate === "/opt/bin/tmux",
      isExecutable: () => true,
    })
    expect(found).toBe("/opt/bin/tmux")
  })

  test("returns null when tmux is absent", () => {
    expect(detectTmuxAvailability({ env: { PATH: "/usr/bin" }, platform: "linux", isFile: () => false, isExecutable: () => true })).toBeNull()
  })

  test("detects tmux through the injected filesystem ports", () => {
    expect(detectTmuxAvailability({
      env: { PATH: "/usr/local/bin" },
      platform: "linux",
      isFile: (candidate) => candidate === "/usr/local/bin/tmux",
      isExecutable: () => true,
    })).toBe("/usr/local/bin/tmux")
  })
})

describe("V2 pty command runner", () => {
  test("creates the pty with the command and args, reads output, and removes the session", async () => {
    const calls = []
    const pty = {
      create: async (input) => { calls.push(["create", input]); return { data: { id: "pty_1" } } },
      remove: async (input) => { calls.push(["remove", input]) },
    }
    const runner = createPtyCommandRunner({
      pty,
      location: { directory: "/work" },
      attach: async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 }),
    })
    const result = await runner.run({ command: "tmux", args: ["list-sessions"] })
    expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 })
    expect(calls).toEqual([
      ["create", { location: { directory: "/work" }, command: "tmux", args: ["list-sessions"] }],
      ["remove", { ptyID: "pty_1", location: { directory: "/work" } }],
    ])
  })

  test("removes the pty even when the output reader fails, then rethrows", async () => {
    const removed = []
    const pty = {
      create: async () => ({ data: { id: "pty_2" } }),
      remove: async (input) => { removed.push(input.ptyID) },
    }
    const runner = createPtyCommandRunner({ pty, attach: async () => { throw new Error("stream unavailable") } })
    await expect(runner.run({ command: "tmux", args: ["list-sessions"] })).rejects.toThrow("stream unavailable")
    expect(removed).toEqual(["pty_2"])
  })

  test("rejects a pty domain that cannot create sessions", () => {
    expect(() => createPtyCommandRunner({ pty: {} })).toThrow("requires a V2 pty domain")
  })

  test("reports an unsupported pty stream instead of returning empty output", async () => {
    const pty = { create: async () => ({ data: { id: "pty_3" } }), remove: async () => {} }
    const runner = createPtyCommandRunner({ pty })
    await expect(runner.run({ command: "tmux", args: ["list-sessions"] })).rejects.toThrow("V2 pty output stream is unavailable")
  })
})
