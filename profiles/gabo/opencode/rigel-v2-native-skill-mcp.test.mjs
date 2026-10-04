import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  applyGrepFilter,
  createCleanMcpEnvironment,
  createSkillMcpManager,
  createSkillMcpToolDefinition,
  getConnectionType,
  parseSkillMcpArguments,
  redactSensitiveData,
  registerSkillMcpServers,
  translateSkillMcpConfig,
} from "./rigel-v2-native-skill-mcp.mjs"

const temporaryRoots = []
const runningServers = []

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-skill-mcp-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  for (const server of runningServers.splice(0)) { try { server.stop(true) } catch { /* already stopped */ } }
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function writeStdioServer() {
  const root = makeRoot()
  const serverPath = path.join(root, "fixture-mcp-server.mjs")
  fs.writeFileSync(serverPath, `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === "initialize") {
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1.0.0" } } })
  }
  if (typeof message.id === "undefined") return
  let result = {}
  switch (message.method) {
    case "tools/list": result = { tools: [{ name: "echo", description: "Echo arguments", inputSchema: { type: "object" } }] }; break
    case "tools/call": result = { content: [{ type: "text", text: "echo:" + JSON.stringify(message.params.arguments) }] }; break
    case "resources/list": result = { resources: [{ uri: "mem://notes", name: "notes" }] }; break
    case "resources/read": result = { contents: [{ uri: message.params.uri, text: "RESOURCE_BODY" }] }; break
    case "prompts/list": result = { prompts: [{ name: "summarize" }] }; break
    case "prompts/get": result = { messages: [{ role: "user", content: { type: "text", text: "PROMPT:" + JSON.stringify(message.params.arguments) } }] }; break
    default: result = {}
  }
  send({ jsonrpc: "2.0", id: message.id, result })
})
`, "utf8")
  return serverPath
}

function stdioConfig(serverPath) {
  return { type: "stdio", command: process.execPath, args: [serverPath] }
}

function info(sessionID, skillName = "demo", serverName = "echo") {
  return { sessionID, skillName, serverName }
}

describe("#given V1 skill MCP server configs", () => {
  test("#when translating #then local/remote map to V2 shape and unsupported configs return null", () => {
    expect(getConnectionType({ url: "http://x" })).toBe("http")
    expect(getConnectionType({ command: "npx" })).toBe("stdio")
    expect(translateSkillMcpConfig({ command: "npx", args: ["-y", "server"], env: { MODE: "x" } }))
      .toEqual({ type: "local", command: ["npx", "-y", "server"], environment: { MODE: "x" } })
    expect(translateSkillMcpConfig({ type: "http", url: "http://127.0.0.1:1/mcp", headers: { a: "b" } }))
      .toEqual({ type: "remote", url: "http://127.0.0.1:1/mcp", headers: { a: "b" } })
    expect(translateSkillMcpConfig({ type: "stdio" })).toBeNull()
    expect(translateSkillMcpConfig({ type: "http" })).toBeNull()
  })

  test("#when the ambient environment is filtered #then secret-bearing vars are dropped and declared env passes through", () => {
    const clean = createCleanMcpEnvironment({ EXPLICIT: "declared" }, { PATH: "/bin", OPENAI_API_KEY: "sk-secret", NPM_CONFIG_X: "1", SAFE: "yes" })
    expect(clean.PATH).toBe("/bin")
    expect(clean.SAFE).toBe("yes")
    expect(clean.EXPLICIT).toBe("declared")
    expect(clean.OPENAI_API_KEY).toBeUndefined()
    expect(clean.NPM_CONFIG_X).toBeUndefined()
  })

  test("#when an error message carries a token #then it is redacted", () => {
    expect(redactSensitiveData("auth failed for sk-abcdefghijklmnopqrstuvwxyz")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
  })

  test("#when arguments arrive as an object or a JSON string #then both are accepted and garbage is rejected", () => {
    expect(parseSkillMcpArguments({ a: 1 })).toEqual({ a: 1 })
    expect(parseSkillMcpArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseSkillMcpArguments("'{\"a\":1}'")).toEqual({ a: 1 })
    expect(() => parseSkillMcpArguments("not json")).toThrow("Invalid arguments JSON")
  })

  test("#when grep is applied #then only matching lines survive and an empty result is explained", () => {
    expect(applyGrepFilter("alpha\nbeta\ngamma", "a$")).toBe("alpha\nbeta\ngamma")
    expect(applyGrepFilter("one\ntwo", "xyz")).toBe("[grep] No lines matched pattern: xyz")
  })
})

describe("#given a real stdio MCP server", () => {
  test("#when the manager drives it #then tools, resources, and prompts round-trip", async () => {
    const manager = createSkillMcpManager()
    const config = stdioConfig(writeStdioServer())
    const tools = await manager.listTools(info("ses_a"), config)
    expect(tools.map((tool) => tool.name)).toEqual(["echo"])
    const content = await manager.callTool(info("ses_a"), config, "echo", { hello: "world" })
    expect(content[0].text).toBe('echo:{"hello":"world"}')
    const resources = await manager.readResource(info("ses_a"), config, "mem://notes")
    expect(resources[0].text).toBe("RESOURCE_BODY")
    const messages = await manager.getPrompt(info("ses_a"), config, "summarize", { text: "hi" })
    expect(messages[0].content.text).toBe('PROMPT:{"text":"hi"}')
    await manager.disconnectAll()
  })

  test("#when two sessions share one skill server #then each gets its own client and disconnect is session-scoped", async () => {
    const manager = createSkillMcpManager()
    const config = stdioConfig(writeStdioServer())
    await manager.callTool(info("ses_one"), config, "echo", { n: 1 })
    await manager.callTool(info("ses_two"), config, "echo", { n: 1 })
    expect(manager.connectedKeys().sort()).toEqual(["ses_one:demo:echo", "ses_two:demo:echo"])
    await manager.disconnectSession("ses_one")
    expect(manager.connectedKeys()).toEqual(["ses_two:demo:echo"])
    expect(manager.isConnected(info("ses_two"))).toBe(true)
    await manager.disconnectAll()
    expect(manager.connectedKeys()).toEqual([])
  })
})

describe("#given a real Streamable HTTP MCP server", () => {
  test("#when the manager drives it #then a tool call round-trips over HTTP", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        const payload = await request.json()
        if (typeof payload.id === "undefined") return new Response(null, { status: 202, headers: { "mcp-session-id": "http-session" } })
        const result = payload.method === "tools/call"
          ? { content: [{ type: "text", text: `http:${JSON.stringify(payload.params.arguments)}` }] }
          : { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "http-fixture", version: "1.0.0" } }
        return Response.json({ jsonrpc: "2.0", id: payload.id, result }, { headers: { "mcp-session-id": "http-session" } })
      },
    })
    runningServers.push(server)
    const manager = createSkillMcpManager()
    const config = { type: "http", url: `http://127.0.0.1:${server.port}/mcp` }
    const content = await manager.callTool(info("ses_http"), config, "echo", { ping: true })
    expect(content[0].text).toBe('http:{"ping":true}')
    await manager.disconnectAll()
  })
})

describe("#given the skill_mcp tool definition", () => {
  test("#when a declared server is called #then the real content is returned and an unknown server explains the builtin path", async () => {
    const serverPath = writeStdioServer()
    const manager = createSkillMcpManager()
    const skills = [{ name: "demo", scope: "project", mcpConfig: { echo: { type: "stdio", command: process.execPath, args: [serverPath] } } }]
    const tool = createSkillMcpToolDefinition({ manager, getSkills: async () => skills })
    const output = await tool.execute({ mcp_name: "echo", tool_name: "echo", arguments: '{"value":1}' }, { sessionID: "ses_tool" })
    expect(output).toContain("echo:")
    expect(output).toContain("value")
    await expect(tool.execute({ mcp_name: "context7", tool_name: "x" }, { sessionID: "ses_tool" })).rejects.toThrow("is a builtin MCP")
    await expect(tool.execute({ mcp_name: "echo" }, { sessionID: "ses_tool" })).rejects.toThrow("Missing operation")
    await expect(tool.execute({ mcp_name: "echo", tool_name: "a", resource_name: "b" }, { sessionID: "ses_tool" })).rejects.toThrow("Multiple operations specified")
    await manager.disconnectAll()
  })

  test("#when no session is available #then the call refuses instead of sharing global state", async () => {
    const manager = createSkillMcpManager()
    const skills = [{ name: "demo", scope: "project", mcpConfig: { echo: { type: "stdio", command: process.execPath, args: [writeStdioServer()] } } }]
    const tool = createSkillMcpToolDefinition({ manager, getSkills: async () => skills })
    await expect(tool.execute({ mcp_name: "echo", tool_name: "echo" }, {})).rejects.toThrow("No active session")
  })
})

describe("#given the V2 native mcp surface", () => {
  test("#when registering skill servers #then they are translated and an existing host server wins the collision", async () => {
    const servers = new Map([["host-owned", { type: "remote", url: "http://host" }]])
    const context = {
      mcp: { transform: async (callback) => { callback({ get: (name) => servers.get(name), set: (name, value) => servers.set(name, value), list: () => [...servers] }); return { dispose() {} } } },
    }
    const skills = [
      { name: "alpha", mcpConfig: { "host-owned": { command: "npx" }, fresh: { command: "npx", args: ["-y", "s"] } } },
    ]
    const registered = await registerSkillMcpServers(context, skills)
    expect(registered.registered).toEqual([{ name: "fresh", skill: "alpha" }])
    expect(servers.get("host-owned")).toEqual({ type: "remote", url: "http://host" })
    expect(servers.get("fresh")).toEqual({ type: "local", command: ["npx", "-y", "s"] })
  })
})
