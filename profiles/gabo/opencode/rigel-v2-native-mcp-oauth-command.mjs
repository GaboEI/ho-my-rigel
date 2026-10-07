// Native OpenCode V2 command for the V1 `cli/mcp-oauth` effect: complete
// the interactive OAuth login of a skill MCP server from inside the runtime,
// without an external CLI. The command is registered through
// `ctx.command.transform` (the V1 subcommand tree becomes one command whose
// arguments arrive on `prompt.text`), and it reuses the existing manager
// provider and localhost callback (`rigel-v2-skill-mcp-oauth.mjs`) instead of
// reimplementing discovery / DCR / PKCE.
//
// V1 parity: `mcp oauth login|logout|status`. Tokens are never printed (only
// `[REDACTED]`), persistence lives in the official `ctx.storage` domain, and a
// headless host warns that the callback must be completed manually instead of
// silently failing to open a browser.

import {
  createNativeOAuthProvider,
  createOAuthTokenStore,
  isTokenExpired,
  normalizeServerHost,
  openSystemBrowser,
} from "./rigel-v2-skill-mcp-oauth.mjs"

const COMMAND_NAME = "mcp-oauth"
const URL_MESSAGE_PREFIX = "Open this URL to authorize:"

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/\S+$/.test(value)
}

/**
 * Parse the command text into the V1 subcommand shape. Returns `{ error }` for
 * a malformed invocation so the caller can report it without throwing.
 */
export function parseMcpOAuthCommand(text) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { error: "Usage: mcp-oauth <login|logout|status> <server-name> [--server-url <url>] [--client-id <id>] [--scopes <scope...>] [--no-browser]" }
  const subcommand = tokens[0].toLowerCase()
  if (!["login", "logout", "status"].includes(subcommand)) {
    return { error: `Unknown mcp-oauth subcommand "${tokens[0]}". Use login, logout, or status.` }
  }
  const positionals = []
  const options = { serverUrl: undefined, clientId: undefined, scopes: [], noBrowser: false }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const readValue = () => {
      const eq = token.indexOf("=")
      if (eq !== -1) return token.slice(eq + 1)
      const next = tokens[index + 1]
      if (next === undefined || next.startsWith("--")) return ""
      index += 1
      return next
    }
    if (token === "--server-url" || token.startsWith("--server-url=")) options.serverUrl = readValue()
    else if (token === "--client-id" || token.startsWith("--client-id=")) options.clientId = readValue()
    else if (token === "--no-browser" || token === "--manual") options.noBrowser = true
    else if (token === "--scope" || token.startsWith("--scope=")) options.scopes.push(...readValue().split(/[\s+]+/).filter(Boolean))
    else if (token === "--scopes" || token.startsWith("--scopes=")) {
      const eq = token.indexOf("=")
      if (eq !== -1) {
        const value = token.slice(eq + 1)
        if (value) options.scopes.push(...value.split(/[\s+]+/).filter(Boolean))
      } else {
        let next = tokens[index + 1]
        while (next !== undefined && !next.startsWith("--")) {
          options.scopes.push(...next.split(/[\s+]+/).filter(Boolean))
          index += 1
          next = tokens[index + 1]
        }
      }
    } else if (token.startsWith("--")) {
      return { error: `Unknown option "${token}".` }
    } else {
      positionals.push(token)
    }
  }
  return {
    subcommand,
    serverName: positionals[0] ?? null,
    serverUrl: options.serverUrl || null,
    clientId: options.clientId || null,
    scopes: options.scopes,
    noBrowser: options.noBrowser,
  }
}

/**
 * A host is headless when no display server can service a browser launch. On
 * non-Linux platforms the V1 behavior (attempt the opener) is preserved.
 */
export function isHeadlessEnvironment(env = process.env, platform = process.platform) {
  if (platform !== "linux") return false
  return !env?.DISPLAY && !env?.WAYLAND_DISPLAY
}

/**
 * Whether the system browser should be launched. Manual callback mode
 * (`--no-browser`) and a headless host both suppress it, so the authorization
 * URL is surfaced for manual completion instead of a browser the host cannot
 * open.
 */
export function shouldOpenSystemBrowser({ headless = false, noBrowser = false } = {}) {
  return !headless && noBrowser !== true
}

function statusLabel(token, now) {
  return isTokenExpired(token, now) ? "EXPIRED" : "VALID"
}

function renderStatus(all, index, arg, now) {
  if (arg) {
    const matches = []
    const argHost = normalizeServerHost(arg)
    for (const entry of all) {
      const info = index.get(entry.hash)
      const hostMatch = argHost && normalizeServerHost(info?.serverUrl) === argHost
      if (info?.serverUrl === arg || info?.name === arg || hostMatch) matches.push({ label: info?.serverUrl ?? entry.hash, token: entry.token })
    }
    if (matches.length === 0) return `No tokens found for ${arg}`
    const lines = [`OAuth Status for ${arg}:`]
    for (const match of matches) {
      lines.push(`  ${match.label}:`)
      lines.push("    Access Token: [REDACTED]")
      if (match.token?.refreshToken) lines.push("    Refresh Token: [REDACTED]")
      if (match.token?.expiresAt) {
        lines.push(`    Expiry: ${new Date(match.token.expiresAt * 1000).toISOString()} (${statusLabel(match.token, now)})`)
      }
    }
    return lines.join("\n")
  }
  if (all.length === 0) return "No OAuth tokens stored"
  const lines = ["Stored OAuth Tokens:"]
  for (const entry of all) {
    const info = index.get(entry.hash)
    const label = info?.name ? `${info.name} (${info.serverUrl})` : info?.serverUrl ?? entry.hash
    lines.push(`  ${label}: ${statusLabel(entry.token, now)}`)
  }
  return lines.join("\n")
}

/**
 * Build the `mcp-oauth` command definition. Every side effect goes through the
 * injected `context` so the command is exercised at its real boundary.
 */
export function createMcpOAuthCommand({ context, storage, fetchImpl, now = () => Date.now(), env = process.env, openBrowser } = {}) {
  const store = createOAuthTokenStore({ storage })
  const headless = isHeadlessEnvironment(env)

  const deliver = async (sessionID, text, delivery) => {
    if (typeof context?.session?.prompt !== "function") return
    // Report through the official command output channel (`session.prompt`), the
    // same surface every native command uses to surface output to the user.
    await context.session.prompt({ sessionID, text, delivery })
  }

  const login = async (invocation, sessionID, delivery) => {
    const { serverName, serverUrl, clientId, scopes, noBrowser } = invocation
    const label = serverName || serverUrl
    if (!serverUrl) {
      await deliver(sessionID, `Error: --server-url is required for server "${label}"`, delivery)
      return
    }
    if (!isHttpUrl(serverUrl)) {
      await deliver(sessionID, `Error: --server-url must be an http(s) URL for server "${label}"`, delivery)
      return
    }
    const manual = !shouldOpenSystemBrowser({ headless, noBrowser })
    const browser = typeof openBrowser === "function"
      ? openBrowser
      : (url) => {
        const notice = manual
          ? "Manual callback mode: complete the callback from a host that can reach the local callback."
          : "A browser window was opened to complete authorization."
        void deliver(sessionID, `${URL_MESSAGE_PREFIX}\n${url}\n${notice}`, delivery)
        if (!manual) openSystemBrowser(url)
      }
    try {
      const provider = createNativeOAuthProvider({
        serverUrl,
        ...(clientId ? { clientId } : {}),
        scopes,
        ...(fetchImpl ? { fetchImpl } : {}),
        storage,
        openBrowser: browser,
      })
      await deliver(sessionID, `Authenticating with ${label}...`, delivery)
      const tokenData = await provider.login()
      await store.remember(serverUrl, serverName ?? undefined)
      const lines = [`Successfully authenticated with ${label}`]
      if (tokenData?.expiresAt) lines.push(`  Token expires at: ${new Date(tokenData.expiresAt * 1000).toISOString()}`)
      await deliver(sessionID, `\u2713 ${lines[0]}${lines[1] ? `\n${lines[1]}` : ""}`, delivery)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await deliver(sessionID, `Error: Failed to authenticate with ${label}: ${message}`, delivery)
    }
  }

  const logout = async (invocation, sessionID, delivery) => {
    const { serverName, serverUrl } = invocation
    const label = serverName || serverUrl
    if (!serverUrl) {
      await deliver(sessionID, "Error: --server-url is required for logout. Token storage uses server URLs, not names.\n  Usage: mcp-oauth logout <server-name> --server-url https://your-server.example.com", delivery)
      return
    }
    let removed
    try {
      removed = await store.clear(serverUrl)
    } catch (error) {
      await deliver(sessionID, `Error: Failed to remove tokens for ${label}: ${error instanceof Error ? error.message : String(error)}`, delivery)
      return
    }
    await deliver(sessionID, removed ? `\u2713 Successfully removed tokens for ${label}` : `Error: Failed to remove tokens for ${label}`, delivery)
  }

  const status = async (invocation, sessionID, delivery) => {
    const arg = invocation.serverUrl || invocation.serverName || null
    try {
      const [all, index] = await Promise.all([store.entries(), store.index()])
      await deliver(sessionID, renderStatus(all, index, arg, now()), delivery)
    } catch (error) {
      await deliver(sessionID, `Error: Failed to get token status: ${error instanceof Error ? error.message : String(error)}`, delivery)
    }
  }

  return {
    name: COMMAND_NAME,
    description: "OAuth token management for MCP servers (login, logout, status).",
    execute: async ({ sessionID, prompt, delivery } = {}) => {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      const text = typeof prompt === "string" ? prompt : prompt?.text ?? ""
      const invocation = parseMcpOAuthCommand(text)
      if (invocation.error) {
        await deliver(sessionID, `Error: ${invocation.error}`, delivery)
        return
      }
      if (invocation.subcommand === "login") return login(invocation, sessionID, delivery)
      if (invocation.subcommand === "logout") return logout(invocation, sessionID, delivery)
      return status(invocation, sessionID, delivery)
    },
  }
}

/**
 * Register the command when the host exposes a command domain and the name is
 * not denied by the materialized `disabled_commands` gate (V1 parity). Returns
 * the host registration (with `dispose`) or `undefined`.
 */
export async function registerMcpOAuthCommand(options = {}) {
  const { context } = options
  if (typeof context?.command?.transform !== "function") return undefined
  const disabled = new Set(Array.isArray(options.disabledCommands) ? options.disabledCommands : [])
  if (disabled.has(COMMAND_NAME)) return undefined
  const definition = createMcpOAuthCommand(options)
  return context.command.transform((editor) => editor.add(definition))
}
