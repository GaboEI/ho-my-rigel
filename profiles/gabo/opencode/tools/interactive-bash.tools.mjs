/**
 * Native V2 port of OmO's `interactive_bash` tool.
 *
 * Source oracle: `packages/omo-opencode/src/tools/interactive-bash/` plus the
 * harness-neutral tmux primitives in `packages/tmux-core/`. The V1 tool spawned
 * the tmux client with `Bun.spawn`; this port keeps the exact V1 observable
 * behavior (tokenizer, prohibited/blocked messages, timeout, exit-code
 * formatting) while a V2-native PTY adapter, not `shell.exec`, runs the command.
 *
 * The tool module is deliberately dependency-injected. The production runtime
 * passes a `createPtyCommandRunner()` port backed by `ctx.pty`; owner tests pass
 * a scripted runner so the observable contract is asserted without a live host.
 */

import fs from "node:fs"

export const INTERACTIVE_BASH_TOOL_NAME = "interactive_bash"

export const DEFAULT_TIMEOUT_MS = 60_000

// V1 constants, byte-for-byte. `capture-pane` and its buffer aliases read the
// terminal, which belongs to the Bash tool; `kill-server` destroys the whole
// tmux server.
export const BLOCKED_TMUX_SUBCOMMANDS = [
  "capture-pane",
  "capturep",
  "save-buffer",
  "saveb",
  "show-buffer",
  "showb",
  "pipe-pane",
  "pipep",
]

export const PROHIBITED_TMUX_SUBCOMMANDS = [
  "kill-server",
]

export const INTERACTIVE_BASH_DESCRIPTION = `WARNING: This is TMUX ONLY. Pass tmux subcommands directly (without 'tmux' prefix).

Examples: new-session -d -s omo-dev, send-keys -t omo-dev "vim" Enter

For TUI apps needing ongoing interaction (vim, htop, pudb). One-shot commands -> use Bash with &.`

const GLOBAL_TMUX_OPTIONS_WITH_ARGS = new Set(["-L", "-S", "-f", "-c", "-T"])

/**
 * Quote-aware command tokenizer with escape handling. Pure port of the V1
 * implementation; handles single/double quotes and backslash escapes without an
 * external dependency.
 */
export function tokenizeCommand(cmd) {
  const tokens = []
  let current = ""
  let inQuote = false
  let quoteChar = ""
  let escaped = false

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === "\\") {
      escaped = true
      continue
    }

    if ((char === "'" || char === '"') && !inQuote) {
      inQuote = true
      quoteChar = char
    } else if (char === quoteChar && inQuote) {
      inQuote = false
      quoteChar = ""
    } else if (char === " " && !inQuote) {
      if (current) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }

  if (current) tokens.push(current)
  return tokens
}

/** Index of the first non-global-option token, skipping options that take an argument. */
export function findSubcommandIndex(parts) {
  let index = 0
  while (index < parts.length) {
    const part = parts[index] ?? ""

    if (part === "--") {
      return index + 1 < parts.length ? index + 1 : -1
    }

    if (GLOBAL_TMUX_OPTIONS_WITH_ARGS.has(part)) {
      index += 2
      continue
    }

    if (part.startsWith("-")) {
      index++
      continue
    }

    return index
  }

  return -1
}

export function getTargetSessionName(parts) {
  const sessionIdx = parts.findIndex((p) => p === "-t" || p.startsWith("-t"))
  if (sessionIdx === -1) {
    return "omo-session"
  }

  const sessionToken = parts[sessionIdx] ?? ""
  const nextToken = parts[sessionIdx + 1]
  if (sessionToken === "-t" && nextToken) {
    return nextToken
  }

  if (sessionToken.startsWith("-t")) {
    return sessionToken.slice(2)
  }

  return "omo-session"
}

export function buildBlockedTmuxCommandMessage(command, parts) {
  const sessionName = getTargetSessionName(parts)

  return `Error: '${command}' is blocked in interactive_bash.

**USE BASH TOOL INSTEAD:**

\`\`\`bash
# Capture terminal output
tmux capture-pane -p -t ${sessionName}

# Or capture with history (last 1000 lines)
tmux capture-pane -p -t ${sessionName} -S -1000
\`\`\`

The Bash tool can execute these commands directly. Do NOT retry with interactive_bash.`
}

export function buildProhibitedTmuxCommandMessage(command) {
  return `Error: '${command}' is prohibited in interactive_bash.

NEVER EVER run tmux kill-server from interactive_bash.

It terminates the entire tmux server, destroying every tmux session and pane that the user, Codex, or other agents may be using.

Use scoped cleanup only:

\`\`\`bash
tmux kill-session -t <session-name>
\`\`\`

If you created an omo-* session, kill only that exact session. Do not retry kill-server with Bash or any other tool.`
}

/** Classify a raw tmux command against the V1 prohibited/blocked lists. */
export function classifyTmuxCommand(parts) {
  const subcommandIndex = findSubcommandIndex(parts)
  const rawSubcommand = subcommandIndex === -1 ? "" : parts[subcommandIndex]
  const subcommand = rawSubcommand.toLowerCase()
  if (PROHIBITED_TMUX_SUBCOMMANDS.includes(subcommand)) {
    return { kind: "prohibited", rawSubcommand }
  }
  if (BLOCKED_TMUX_SUBCOMMANDS.includes(subcommand)) {
    return { kind: "blocked", rawSubcommand }
  }
  return { kind: "allowed", rawSubcommand }
}

// ---------------------------------------------------------------------------
// tmux availability detection (the `interactive_bash` gate)
// ---------------------------------------------------------------------------

function defaultFsPorts() {
  // Deferred so unit tests can run without touching the real filesystem.
  return {
    isFile: (candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      } catch {
        return false
      }
    },
    isExecutable: (candidate) => {
      if (process.platform === "win32") return true
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * Scan `PATH` for an executable without spawning a process. Pure when the
 * `isFile`/`isExecutable` ports are injected.
 */
export function findExecutableOnPath({ command, env = {}, platform = process.platform, isFile, isExecutable } = {}) {
  if (typeof command !== "string" || !command) return null
  const pathValue = env.PATH ?? env.Path ?? ""
  if (typeof pathValue !== "string" || !pathValue) return null
  const separator = platform === "win32" ? ";" : ":"
  const candidates = [command]
  if (platform === "win32" && !/\.[a-zA-Z0-9]+$/.test(command)) {
    const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim()).filter(Boolean)
    for (const ext of pathext) candidates.push(`${command}${ext.toLowerCase()}`, `${command}${ext.toUpperCase()}`)
  }
  for (const directory of pathValue.split(separator)) {
    const dir = directory.trim().replace(/^"(.*)"$/, "$1")
    if (!dir) continue
    for (const candidate of candidates) {
      const full = platform === "win32" ? `${dir}\\${candidate}` : `${dir}/${candidate}`
      if (isFile(full) && isExecutable(full)) return full
    }
  }
  return null
}

/**
 * The `interactive_bash` gate: register only when a real tmux executable is
 * resolvable on this host. `ports` lets the owner test drive both branches.
 */
export function detectTmuxAvailability({ env = process.env, platform = process.platform, ...ports } = {}) {
  const fsPorts = { ...defaultFsPorts(), ...ports }
  return findExecutableOnPath({ command: "tmux", env, platform, ...fsPorts })
}

// ---------------------------------------------------------------------------
// V2-native PTY command runner
// ---------------------------------------------------------------------------

/**
 * Run a command through OpenCode V2's PTY surface instead of a raw subprocess.
 *
 * `pty` is the V2 `ctx.pty` domain. `attach` is the output port: the V2 PTY API
 * streams through `pty.connect`, which returns a WebSocket, so callers inject a
 * reader that yields `{ data, exitCode }`. The default attach uses the global
 * `WebSocket` after obtaining a connect ticket; a host whose PTY surface cannot
 * stream output surfaces a clear error instead of silently returning empty.
 */
export function createPtyCommandRunner({ pty, location, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, attach, now = () => Date.now() } = {}) {
  if (!pty || typeof pty.create !== "function" || typeof pty.remove !== "function") {
    throw new TypeError("createPtyCommandRunner requires a V2 pty domain with create/remove")
  }

  const readOutput = attach ?? ((input) => defaultPtyAttach({ ...input, baseUrl }))

  return {
    async run({ command, args = [], cwd, env } = {}) {
      const created = await pty.create({
        ...(location ? { location } : {}),
        command,
        args,
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
      })
      const ptyID = created?.data?.id ?? created?.id
      if (typeof ptyID !== "string" || !ptyID) {
        throw new Error("V2 pty.create did not return a ptyID")
      }

      const startedAt = now()
      let result
      try {
        result = await readOutput({ pty, ptyID, location, timeoutMs, startedAt, now })
      } catch (error) {
        try {
          await pty.remove({ ptyID, ...(location ? { location } : {}) })
        } catch {
          // Removal failure must not mask the original output error.
        }
        throw error
      }

      try {
        await pty.remove({ ptyID, ...(location ? { location } : {}) })
      } catch {
        // An exited session may already be gone; the command result still stands.
      }
      return result
    },
  }
}

/**
 * Default PTY output reader. V2 streams a PTY over a WebSocket at
 * `/api/pty/{ptyID}/connect?ticket=...`; the ticket comes from `connectToken`.
 * When the host cannot provide a base URL or a global WebSocket, this reports
 * the unsupported primitive instead of pretending the command produced no
 * output. Owner tests inject `attach` and do not exercise this path.
 */
async function defaultPtyAttach({ pty, ptyID, location, timeoutMs, now, startedAt, baseUrl }) {
  const token = typeof pty.connectToken === "function"
    ? await pty.connectToken({ ptyID, ...(location ? { location } : {}) })
    : undefined
  const ticket = token?.data?.ticket ?? token?.ticket
  const WebSocketImpl = globalThis.WebSocket
  if (typeof WebSocketImpl !== "function" || typeof baseUrl !== "string" || !baseUrl || typeof ticket !== "string" || !ticket) {
    throw new Error("V2 pty output stream is unavailable on this host")
  }

  const url = new URL(`/api/pty/${encodeURIComponent(ptyID)}/connect`, baseUrl)
  if (url.protocol === "http:") url.protocol = "ws:"
  else if (url.protocol === "https:") url.protocol = "wss:"
  url.searchParams.set("ticket", ticket)

  return await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url)
    const chunks = []
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* already closed */ }
      reject(new Error(`Timeout after ${timeoutMs}ms`))
    }, Math.max(0, timeoutMs - (now() - startedAt)))

    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : ""
      if (typeof data === "string" && data.length > 0) chunks.push(data)
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("V2 pty output stream failed"))
    })
    socket.addEventListener("close", (event) => {
      clearTimeout(timer)
      resolve({ stdout: chunks.join(""), stderr: "", exitCode: typeof event?.code === "number" && event.code !== 0 ? event.code : 0 })
    })
  })
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const INTERACTIVE_BASH_TOOL_INPUT = {
  type: "object",
  properties: {
    tmux_command: { type: "string", description: "The tmux command to execute (without 'tmux' prefix)" },
  },
  required: ["tmux_command"],
  additionalProperties: false,
}

/**
 * Create the `interactive_bash` ToolDefinition for the V2 `tool.transform`
 * editor. `runner` returns `{ stdout, stderr, exitCode }`; `tmuxPath` is the
 * resolved executable used to launch the tmux client through the PTY.
 */
export function createInteractiveBashTool({ runner, tmuxPath = "tmux", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!runner || typeof runner.run !== "function") {
    throw new TypeError("createInteractiveBashTool requires a runner with run()")
  }

  return {
    name: INTERACTIVE_BASH_TOOL_NAME,
    options: { codemode: false },
    description: INTERACTIVE_BASH_DESCRIPTION,
    input: INTERACTIVE_BASH_TOOL_INPUT,
    async execute(input = {}) {
      const raw = typeof input.tmux_command === "string" ? input.tmux_command : ""
      const parts = tokenizeCommand(raw)
      if (parts.length === 0) {
        return "Error: Empty tmux command"
      }

      const classification = classifyTmuxCommand(parts)
      if (classification.kind === "prohibited") {
        return buildProhibitedTmuxCommandMessage(classification.rawSubcommand)
      }
      if (classification.kind === "blocked") {
        return buildBlockedTmuxCommandMessage(classification.rawSubcommand, parts)
      }

      try {
        const result = await runner.run({ command: tmuxPath, args: parts, timeoutMs })
        const stdout = typeof result?.stdout === "string" ? result.stdout : ""
        const stderr = typeof result?.stderr === "string" ? result.stderr : ""
        const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 0
        if (exitCode !== 0) {
          const errorMsg = stderr.trim() || `Command failed with exit code ${exitCode}`
          return `Error: ${errorMsg}`
        }
        return stdout || "(no output)"
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Error: ${message}`
      }
    },
  }
}
