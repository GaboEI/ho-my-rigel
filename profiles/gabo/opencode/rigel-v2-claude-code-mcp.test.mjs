import { describe, expect, test } from "bun:test"
import {
  expandMcpEnvReferences,
  loadClaudeCodeMcpServers,
  registerClaudeCodeMcps,
} from "./rigel-v2-claude-code-mcp.mjs"

function withTempFiles(files) {
  const paths = Object.keys(files)
  for (const [path, content] of Object.entries(files)) {
    const fs = require("node:fs")
    const path2 = require("node:path")
    fs.mkdirSync(path2.dirname(path), { recursive: true })
    fs.writeFileSync(path, content)
  }
  return () => { for (const path of paths) require("node:fs").rmSync(path, { force: true }) }
}

const PROJECT_MCP_JSON = JSON.stringify({
  mcpServers: {
    docs: { type: "http", url: "https://docs.example.com/mcp" },
    helper: { command: "node", args: ["helper.js"], env: { TOKEN: "${QA_MCP_TOKEN}", HOME_REF: "${HOME}" } },
    stale: { command: "gone.js", disabled: true },
  },
})
const USER_MCP_JSON = JSON.stringify({
  mcpServers: {
    helper: { command: "node", args: ["user-helper.js"] },
  },
})

describe("tier-2 claude-code mcp loader", () => {
  test("expands allowed vars, refuses allowlisted-out names to their default", () => {
    const env = { QA_MCP_TOKEN: "secret-1" }
    expect(expandMcpEnvReferences("${QA_MCP_TOKEN}", { env, isAllowed: (n) => n === "QA_MCP_TOKEN" })).toBe("secret-1")
    expect(expandMcpEnvReferences("${HOME:-closed}", { env: {}, isAllowed: () => false, onBlocked: () => {} })).toBe("closed")
    expect(expandMcpEnvReferences("${HOME}", { env: {}, isAllowed: () => false, onBlocked: () => {} })).toBe("")
  })

  test("loads project and user scopes with last-wins, disabled removal, and allowlist expansion", () => {
    // given
    const directory = "/tmp/qa-omr-project"
    const home = "/tmp/qa-omr-home"
    const cleanup = withTempFiles({
      [`${directory}/.mcp.json`]: PROJECT_MCP_JSON,
      [`${home}/.claude.json`]: USER_MCP_JSON,
    })
    try {
      // when
      const { servers, blocked } = loadClaudeCodeMcpServers({
        directory,
        home,
        disabledMcps: [],
        allowlist: ["QA_MCP_TOKEN"],
        env: { QA_MCP_TOKEN: "secret-1", HOME: "/tmp/qa-omr-ambient-home" },
      })
      // then: user helper is overridden by the project helper (later scope wins)
      expect(servers.helper.command).toEqual(["node", "helper.js"])
      // allowlisted var expands; HOME is NOT in the allowlist so it falls to empty
      expect(servers.helper.environment?.TOKEN).toBe("secret-1")
      expect(servers.helper.environment?.HOME_REF).toBe("")
      expect(blocked).toEqual(["HOME"])
      // remote translation
      expect(servers.docs).toMatchObject({ type: "remote", url: "https://docs.example.com/mcp" })
      // disabled server never loads
      expect(servers.stale).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("a disabled_mcps entry is skipped and disabled:true removes an earlier scope winner", () => {
    // given
    const directory = "/tmp/qa-omr-project2"
    const home = "/tmp/qa-omr-home2"
    const cleanup = withTempFiles({
      [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { helper: { command: "user.js" }, docs: { type: "http", url: "https://x" } } }),
      [`${directory}/.mcp.json`]: JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://x" }, helper: { command: "user.js", disabled: true } } }),
    })
    try {
      // when
      const { servers } = loadClaudeCodeMcpServers({ directory, home, disabledMcps: ["docs"], allowlist: [] })
      // then
      expect(servers.docs).toBeUndefined()
      expect(servers.helper).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("registration adds only names the host does not already declare", async () => {
    // given
    const directory = "/tmp/qa-omr-project3"
    const home = "/tmp/qa-omr-home3"
    const cleanup = withTempFiles({
      [`${directory}/.mcp.json`]: JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" }, fresh: { command: "fresh.js" } } }),
    })
    try {
      const setCalls = []
      const context = { mcp: { transform: async (callback) => {
        callback({ list: () => [{ name: "docs" }], set: (name, config) => setCalls.push([name, config]) })
        return { dispose() {} }
      } } }
      // when
      const result = await registerClaudeCodeMcps(context, { directory, home, allowlist: [] })
      // then
      expect(result.registered).toEqual(["fresh"])
      expect(setCalls.map(([name]) => name)).toEqual(["fresh"])
      expect(setCalls[0][1]).toMatchObject({ type: "local", command: ["fresh.js"], enabled: true })
    } finally {
      cleanup()
    }
  })

  test("a host without the mcp domain degrades to a no-op registration", async () => {
    const result = await registerClaudeCodeMcps({}, { directory: "/qa/x" })
    expect(result.registered).toEqual([])
  })
})
