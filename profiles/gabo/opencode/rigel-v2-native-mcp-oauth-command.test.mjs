import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import {
  createMcpOAuthCommand,
  isHeadlessEnvironment,
  parseMcpOAuthCommand,
  registerMcpOAuthCommand,
  shouldOpenSystemBrowser,
} from "./rigel-v2-native-mcp-oauth-command.mjs"
import { TOKEN_INDEX_PREFIX, TOKEN_STORAGE_PREFIX, createOAuthTokenStore, normalizeServerHost, tokenStorageKey } from "./rigel-v2-skill-mcp-oauth.mjs"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan({ prefix, after, limit } = {}) {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix ?? "")).sort()
      const start = after ? keys.indexOf(after) + 1 : 0
      const slice = limit ? keys.slice(start, start + limit) : keys.slice(start)
      return { entries: slice.map((key) => ({ key, value: map.get(key) })) }
    },
  }
}

function createSessionCapture() {
  const delivered = []
  let resolveUrl
  const urlPromise = new Promise((resolve) => { resolveUrl = resolve })
  return {
    delivered,
    urlPromise,
    context: { session: { prompt: async ({ text }) => {
      delivered.push(text)
      const match = /Open this URL to authorize:\n(https?:\/\/\S+)/.exec(text)
      if (match && resolveUrl) { const resolve = resolveUrl; resolveUrl = null; resolve(match[1]) }
    } } },
  }
}

// A real loopback authorization server: discovery, DCR, and token endpoints are
// served over HTTP so the command is exercised at its real wire boundary. The
// callback (on a separate random port) is driven by the injected openBrowser.
function startOAuthServer({ tokenStatus = 200, tokenError = null } = {}) {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    requests.push(`${request.method} ${url.pathname}`)
    const origin = `http://127.0.0.1:${server.address().port}`
    const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)) }
    if (url.pathname === "/.well-known/oauth-protected-resource") return send(200, { authorization_servers: [origin] })
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      })
    }
    if (url.pathname === "/register") return send(200, { client_id: "loopback-client" })
    if (url.pathname === "/token") {
      if (tokenStatus !== 200) return send(tokenStatus, tokenError ?? { error: "invalid_grant" })
      return send(200, { access_token: "loopback-access", refresh_token: "loopback-refresh", expires_in: 3600 })
    }
    return send(404, {})
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((done) => server.close(done)),
    }))
  })
}

function driveBrowser({ state = null } = {}) {
  return (authorizeUrl) => {
    const url = new URL(authorizeUrl)
    const redirect = url.searchParams.get("redirect_uri")
    const issuedState = url.searchParams.get("state")
    return fetch(`${redirect}?code=test-code&state=${encodeURIComponent(state ?? issuedState)}`)
  }
}

const servers = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function startServer(options) {
  const server = await startOAuthServer(options)
  servers.push(server)
  return server
}

async function invoke(command, text) {
  await command.execute({ sessionID: "ses_t30", prompt: { text }, delivery: "queue" })
}

describe("mcp-oauth command parsing", () => {
  test("login carries name, server url, client id, and scopes", () => {
    const parsed = parseMcpOAuthCommand("login myserver --server-url http://127.0.0.1:9 --client-id c1 --scopes mcp:read mcp:write")
    expect(parsed).toMatchObject({ subcommand: "login", serverName: "myserver", serverUrl: "http://127.0.0.1:9", clientId: "c1", scopes: ["mcp:read", "mcp:write"] })
  })

  test("status accepts a bare server name and an unknown subcommand is an error", () => {
    expect(parseMcpOAuthCommand("status myserver")).toMatchObject({ subcommand: "status", serverName: "myserver" })
    expect(parseMcpOAuthCommand("frobnicate x").error).toBeString()
    expect(parseMcpOAuthCommand("").error).toBeString()
  })

  test("headless detection follows the display environment on linux", () => {
    expect(isHeadlessEnvironment({}, "linux")).toBe(true)
    expect(isHeadlessEnvironment({ DISPLAY: ":0" }, "linux")).toBe(false)
    expect(isHeadlessEnvironment({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false)
    expect(isHeadlessEnvironment({}, "darwin")).toBe(false)
  })

  test("manual callback mode and headless both suppress the system browser", () => {
    expect(shouldOpenSystemBrowser({ headless: false, noBrowser: false })).toBe(true)
    expect(shouldOpenSystemBrowser({ headless: true, noBrowser: false })).toBe(false)
    expect(shouldOpenSystemBrowser({ headless: false, noBrowser: true })).toBe(false)
  })

  test("--no-browser is parsed as manual callback mode", () => {
    expect(parseMcpOAuthCommand("login s --server-url http://127.0.0.1:9 --no-browser").noBrowser).toBe(true)
    expect(parseMcpOAuthCommand("login s --server-url http://127.0.0.1:9").noBrowser).toBe(false)
  })

  test("a flag is never consumed as another flag's value", () => {
    const parsed = parseMcpOAuthCommand("login s --server-url --no-browser")
    expect(parsed.serverUrl).toBeNull()
    expect(parsed.noBrowser).toBe(true)
  })
})

describe("mcp-oauth command execution", () => {
  test("login completes PKCE against the loopback server and persists the token with an index entry", async () => {
    const server = await startServer()
    const storage = memoryStorage()
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage, openBrowser: driveBrowser() })

    await invoke(command, `login myserver --server-url ${server.url}`)

    expect(capture.delivered.some((text) => text.includes("Successfully authenticated with myserver"))).toBe(true)
    expect(server.requests).toContain("POST /register")
    expect(server.requests.filter((entry) => entry === "POST /token").length).toBe(1)
    const token = storage.map.get(tokenStorageKey(server.url))
    expect(token?.accessToken).toBe("loopback-access")
    const index = storage.map.get(`${TOKEN_INDEX_PREFIX}${tokenStorageKey(server.url).slice(TOKEN_STORAGE_PREFIX.length)}`)
    expect(index).toMatchObject({ serverUrl: server.url, name: "myserver" })
    // No delivered line may leak a token value.
    expect(capture.delivered.some((text) => text.includes("loopback-access") || text.includes("loopback-refresh"))).toBe(false)
  })

  test("manual callback mode completes login without opening a browser", async () => {
    const server = await startServer()
    const storage = memoryStorage()
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage })

    const invocation = invoke(command, `login myserver --no-browser --server-url ${server.url}`)
    const authorizeUrl = await capture.urlPromise
    const url = new URL(authorizeUrl)
    await fetch(`${url.searchParams.get("redirect_uri")}?code=manual-code&state=${encodeURIComponent(url.searchParams.get("state"))}`)
    await invocation

    expect(capture.delivered.some((text) => text.includes("Manual callback mode"))).toBe(true)
    expect(capture.delivered.some((text) => text.includes("Successfully authenticated with myserver"))).toBe(true)
    expect(storage.map.get(tokenStorageKey(server.url))?.accessToken).toBe("loopback-access")
  })

  test("a callback state mismatch fails clearly and persists nothing", async () => {
    const server = await startServer()
    const storage = memoryStorage()
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage, openBrowser: driveBrowser({ state: "tampered" }) })

    await invoke(command, `login myserver --server-url ${server.url}`)

    expect(capture.delivered.some((text) => text.includes("Failed to authenticate") && text.includes("state parameter mismatch"))).toBe(true)
    expect(storage.map.has(tokenStorageKey(server.url))).toBe(false)
    expect(server.requests).not.toContain("POST /token")
  })

  test("a token endpoint error is surfaced and nothing is persisted", async () => {
    const server = await startServer({ tokenStatus: 400, tokenError: { error: "invalid_grant", error_description: "code already used" } })
    const storage = memoryStorage()
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage, openBrowser: driveBrowser() })

    await invoke(command, `login myserver --server-url ${server.url}`)

    expect(capture.delivered.some((text) => text.includes("invalid_grant: code already used"))).toBe(true)
    expect(storage.map.has(tokenStorageKey(server.url))).toBe(false)
  })

  test("login without --server-url mirrors the V1 requirement and never persists", async () => {
    const storage = memoryStorage()
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage })

    await invoke(command, "login myserver")

    expect(capture.delivered.some((text) => text.includes('--server-url is required for server "myserver"'))).toBe(true)
    expect(storage.map.size).toBe(0)
  })

  test("status reports VALID/EXPIRED redacted entries and logout clears them", async () => {
    const server = await startServer()
    const storage = memoryStorage()
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage, openBrowser: driveBrowser() })

    await invoke(command, `login myserver --server-url ${server.url}`)
    await invoke(command, "status myserver")
    const statusText = capture.delivered.at(-1)
    expect(statusText).toContain("OAuth Status for myserver:")
    expect(statusText).toContain("Access Token: [REDACTED]")
    expect(statusText).toContain("(VALID)")

    await invoke(command, "status")
    expect(capture.delivered.at(-1)).toContain("Stored OAuth Tokens:")
    expect(capture.delivered.at(-1)).toContain("VALID")

    await invoke(command, `logout myserver --server-url ${server.url}`)
    expect(capture.delivered.at(-1)).toContain("Successfully removed tokens for myserver")
    expect(storage.map.has(tokenStorageKey(server.url))).toBe(false)

    await invoke(command, "status")
    expect(capture.delivered.at(-1)).toBe("No OAuth tokens stored")
  })

  test("an expired token is reported EXPIRED", async () => {
    const storage = memoryStorage()
    const server = { url: "http://127.0.0.1:9" }
    await storage.set(tokenStorageKey(server.url), { accessToken: "a", expiresAt: 1 })
    await storage.set(`${TOKEN_INDEX_PREFIX}${tokenStorageKey(server.url).slice(TOKEN_STORAGE_PREFIX.length)}`, { serverUrl: server.url, name: "expired" })
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage, now: () => 10_000_000_000 })

    await invoke(command, "status expired")

    expect(capture.delivered.at(-1)).toContain("(EXPIRED)")
  })

  test("status addresses a token by host as V1 did (scheme/port tolerant)", async () => {
    const server = await startServer()
    const storage = memoryStorage()
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage, openBrowser: driveBrowser() })

    await invoke(command, `login hostname --server-url ${server.url}`)
    await invoke(command, "status 127.0.0.1")

    expect(capture.delivered.at(-1)).toContain("OAuth Status for 127.0.0.1:")
  })

  test("logout and status surface storage failures with the V1 error text", async () => {
    const storage = memoryStorage()
    storage.remove = async () => { throw new Error("storage offline") }
    storage.scan = async () => { throw new Error("scan offline") }
    const capture = createSessionCapture()
    const command = createMcpOAuthCommand({ context: capture.context, storage })

    await invoke(command, "logout s --server-url https://s.example")
    expect(capture.delivered.at(-1)).toContain("Failed to remove tokens for s: storage offline")

    await invoke(command, "status")
    expect(capture.delivered.at(-1)).toContain("Failed to get token status: scan offline")
  })
})

describe("mcp-oauth token store", () => {
  test("save, load, remember, index and clear round-trip over ctx.storage", async () => {
    const storage = memoryStorage()
    const store = createOAuthTokenStore({ storage })

    await store.save("https://s.example/mcp", { accessToken: "a1", expiresAt: 2 })
    await store.remember("https://s.example/mcp", "s")

    expect((await store.load("https://s.example/mcp"))?.accessToken).toBe("a1")
    expect((await store.entries()).map((entry) => entry.token.accessToken)).toEqual(["a1"])
    const hash = tokenStorageKey("https://s.example/mcp").slice(TOKEN_STORAGE_PREFIX.length)
    expect((await store.index()).get(hash)).toMatchObject({ serverUrl: "https://s.example/mcp", name: "s" })

    expect(await store.clear("https://s.example/mcp")).toBe(true)
    expect(await store.load("https://s.example/mcp")).toBeNull()
    expect(await store.entries()).toEqual([])
  })

  test("entries follows a next cursor across pages and tolerates a bare-array page", async () => {
    const map = new Map()
    map.set(tokenStorageKey("https://a.example"), { accessToken: "ta" })
    map.set(tokenStorageKey("https://b.example"), { accessToken: "tb" })
    // {entries,next} pages of one entry each.
    const paged = createOAuthTokenStore({ storage: {
      async get(key) { return map.get(key) },
      async set(key, value) { map.set(key, value) },
      async remove(key) { map.delete(key) },
      async scan({ prefix, after } = {}) {
        const keys = [...map.keys()].filter((key) => key.startsWith(prefix ?? "")).sort()
        const start = after ? keys.indexOf(after) + 1 : 0
        const slice = keys.slice(start, start + 1)
        return { entries: slice.map((key) => ({ key, value: map.get(key) })), ...(slice.length ? { next: slice.at(-1) } : {}) }
      },
    } })
    expect((await paged.entries()).map((entry) => entry.token.accessToken).sort()).toEqual(["ta", "tb"])

    // Bare array page (no wrapper): the whole result is returned at once.
    const bare = createOAuthTokenStore({ storage: {
      async get(key) { return map.get(key) },
      async set(key, value) { map.set(key, value) },
      async remove(key) { map.delete(key) },
      async scan({ prefix } = {}) {
        return [...map.entries()].filter(([key]) => key.startsWith(prefix ?? "")).sort().map(([key, value]) => ({ key, value }))
      },
    } })
    expect((await bare.entries()).length).toBe(2)
  })

  test("normalizeServerHost reduces a URL or host to the bare host", () => {
    expect(normalizeServerHost("https://auth.example.com:8443/path")).toBe("auth.example.com")
    expect(normalizeServerHost("127.0.0.1:9")).toBe("127.0.0.1")
    expect(normalizeServerHost("")).toBe("")
  })
})

describe("mcp-oauth command registration", () => {
  test("registers through the command transform, honors disabled_commands, and no-ops without a command domain", async () => {
    let added
    const context = { command: { transform: (callback) => { callback({ add: (definition) => { added = definition } }); return { dispose() {} } } } }

    const registration = await registerMcpOAuthCommand({ context, storage: memoryStorage() })
    expect(registration).toBeTruthy()
    expect(added?.name).toBe("mcp-oauth")

    expect(await registerMcpOAuthCommand({ context, storage: memoryStorage(), disabledCommands: ["mcp-oauth"] })).toBeUndefined()
    expect(await registerMcpOAuthCommand({ context: {}, storage: memoryStorage() })).toBeUndefined()
  })
})
