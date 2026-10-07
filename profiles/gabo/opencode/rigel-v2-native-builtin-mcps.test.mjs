import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"

import {
  GREP_APP_MCP,
  createAncestorCliCandidates,
  createBuiltinMcpConfigs,
  createLspMcpConfig,
  hasCliSuffix,
  registerNativeBuiltinMcps,
  resolveOpenCodeConfigDir,
  resolveRuntimeExecutable,
} from "./rigel-v2-native-builtin-mcps.mjs"

const REPO = "/repo"
const DAEMON_DIST = path.join(REPO, "packages/lsp-daemon/dist/cli.js")
const DAEMON_SOURCE = path.join(REPO, "packages/lsp-daemon/src/cli.ts")
const TOOLS_DIST = path.join(REPO, "packages/lsp-tools-mcp/dist/cli.js")
const DAEMON_PKG = path.join(REPO, "packages/lsp-daemon/package.json")
const ROOT_PKG = path.join(REPO, "package.json")

function layout({ dist = false, source = false, toolsDist = false, daemonVersion = "9.9.9" } = {}) {
  const files = new Map()
  if (dist) files.set(DAEMON_DIST, "")
  if (source) files.set(DAEMON_SOURCE, "")
  if (toolsDist) files.set(TOOLS_DIST, "")
  files.set(DAEMON_PKG, JSON.stringify({ version: daemonVersion }))
  files.set(ROOT_PKG, "{}")
  return {
    exists: (candidate) => files.has(candidate),
    readFile: (candidate) => {
      if (!files.has(candidate)) throw new Error(`ENOENT: ${candidate}`)
      return files.get(candidate)
    },
  }
}

const available = (name) => ({ command: `/usr/bin/${name}`, available: true })
const unavailable = (name) => ({ command: name, available: false })

function fakeCollection(existing = []) {
  const map = new Map(existing.map((name) => [name, { type: "remote", url: "https://existing.invalid" }]))
  return { get: (name) => map.get(name), set: (name, config) => map.set(name, config), map }
}

function fakeDomain(collection, disposer) {
  return { transform: async (callback) => { callback(collection); return { dispose: disposer } } }
}

describe("native builtin MCP port", () => {
  describe("#given hasCliSuffix #when comparing paths #then it normalizes separators", () => {
    test("#then windows separators match and a different suffix does not", () => {
      expect(hasCliSuffix("C:\\a\\dist\\cli.js", "dist/cli.js")).toBe(true)
      expect(hasCliSuffix("/a/dist/cli.js", "src/cli.ts")).toBe(false)
    })
  })

  describe("#given resolveRuntimeExecutable #when the command name is unsafe #then it is unavailable", () => {
    test("#then traversal, separators, drive letters and NUL are refused", () => {
      for (const name of ["../node", "a/b", "a\\b", "C:node", "node\0evil", ""]) {
        expect(resolveRuntimeExecutable(name)).toEqual({ command: name, available: false })
      }
    })

    test("#then node resolves to the running node executable and other commands go through which", () => {
      expect(resolveRuntimeExecutable("node", { execPath: "/usr/bin/node" })).toEqual({ command: "/usr/bin/node", available: true })
      expect(resolveRuntimeExecutable("bun", { which: () => "/opt/bun" })).toEqual({ command: "/opt/bun", available: true })
      expect(resolveRuntimeExecutable("bun", { which: () => null })).toEqual({ command: "bun", available: false })
    })
  })

  describe("#given createAncestorCliCandidates #when walking the repo root #then dist and source candidates are emitted", () => {
    test("#then the repo candidate carries both CLI shapes", () => {
      const fsx = layout({ dist: true, source: true, toolsDist: true })
      const candidates = createAncestorCliCandidates({
        startDirectory: REPO,
        packageRel: "packages/lsp-daemon",
        distCliRel: "dist/cli.js",
        sourceCliRel: "src/cli.ts",
        pathExists: fsx.exists,
        resolveExecutable: available,
      })
      expect(candidates[0].path).toBe(DAEMON_DIST)
      expect(candidates[0].exists).toBe(true)
      expect(candidates[1].path).toBe(DAEMON_SOURCE)
      expect(candidates[1].exists).toBe(true)
    })
  })

  describe("#given createLspMcpConfig #when the dist CLI is present #then it becomes a V2 local server", () => {
    test("#then the command runs the dist CLI under node and the env is lab-scoped", () => {
      const fsx = layout({ dist: true, source: true, toolsDist: true })
      const config = createLspMcpConfig({ repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: available })
      expect(config.type).toBe("local")
      expect(config.disabled).toBe(false)
      expect(config.command).toEqual(["/usr/bin/node", DAEMON_DIST, "mcp"])
      expect(config.cwd).toBe("/work")
      expect(config.environment.LSP_TOOLS_MCP_CWD).toBe("/work")
      expect(config.environment.LSP_TOOLS_MCP_USER_CONFIG).toBe("/labcfg/lsp.json")
      expect(config.environment.LSP_TOOLS_MCP_INSTALL_DECISIONS).toBe("/labcfg/lsp-install-decisions.json")
      expect(config.environment.LSP_TOOLS_MCP_PROJECT_CONFIG).toBe(
        [".opencode/lsp.json", ".omo/lsp.json", ".omo/lsp-client.json"].map((entry) => path.join("/work", entry)).join(path.delimiter),
      )
    })
  })

  describe("#given createLspMcpConfig #when only the source CLI is available #then it runs under bun with the daemon markers", () => {
    test("#then the source candidate is selected and OMO_LSP_DAEMON_CLI/VERSION are exported", () => {
      const fsx = layout({ dist: false, source: true, toolsDist: true, daemonVersion: "1.2.3" })
      const config = createLspMcpConfig({ repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: available })
      expect(config.command).toEqual(["/usr/bin/bun", DAEMON_SOURCE, "mcp"])
      expect(config.environment.OMO_LSP_DAEMON_CLI).toBe(DAEMON_SOURCE)
      expect(config.environment.OMO_LSP_DAEMON_VERSION).toBe("1.2.3")
      expect(config.disabled).toBe(false)
    })
  })

  describe("#given createLspMcpConfig #when no CLI exists #then it degrades to the bootstrap script", () => {
    test("#then the bootstrap candidate is used when the runtime and npm are present", () => {
      const fsx = layout({ dist: false, source: false, toolsDist: false })
      const config = createLspMcpConfig({ repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: available })
      expect(config.command[0]).toBe("/usr/bin/node")
      expect(config.command[1]).toBe("-e")
      expect(config.command[3]).toBe(REPO)
      expect(config.disabled).toBe(false)
    })

    test("#then the server is disabled when the runtime is unavailable", () => {
      const fsx = layout({ dist: false, source: false, toolsDist: false })
      const config = createLspMcpConfig({ repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: unavailable })
      expect(config.disabled).toBe(true)
    })
  })

  describe("#given createBuiltinMcpConfigs #when applying the retention policy #then only retained builtins are emitted", () => {
    test("#then grep_app and lsp are emitted and context7/websearch are never present", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: ["context7"], retained: ["grep_app", "lsp"], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs).sort()).toEqual(["grep_app", "lsp"])
      expect(configs.grep_app).toEqual({ type: "remote", url: "https://mcp.grep.app", disabled: false, oauth: false })
      expect(configs.context7).toBeUndefined()
      expect(configs.websearch).toBeUndefined()
    })

    test("#then a disabled retained server is omitted", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: ["grep_app"], retained: ["grep_app", "lsp"], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs)).toEqual(["lsp"])
    })

    test("#then a server outside the retained list is omitted", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: [], retained: ["grep_app"], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs)).toEqual(["grep_app"])
    })

    test("#then an absent retained list defaults to both retained builtins", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: [], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs).sort()).toEqual(["grep_app", "lsp"])
    })
  })

  describe("#given registerNativeBuiltinMcps #when the host exposes mcp.transform #then servers are registered once", () => {
    test("#then grep_app and lsp are set and a host collision is preserved", async () => {
      const collection = fakeCollection(["tavily"])
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, { repoRoot: REPO, cwd: "/w", configDir: "/c", disabledMcps: ["context7"], retained: ["grep_app", "lsp"], exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(result.registered).toEqual(["grep_app", "lsp"])
      expect(collection.map.get("grep_app").url).toBe("https://mcp.grep.app")
      expect(collection.map.get("lsp").type).toBe("local")
      expect(collection.map.get("tavily").url).toBe("https://existing.invalid")
    })

    test("#then an existing server of the same name wins and is not overwritten", async () => {
      const collection = fakeCollection(["grep_app"])
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, { repoRoot: REPO, cwd: "/w", configDir: "/c", disabledMcps: [], retained: ["grep_app", "lsp"], exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(result.registered).toEqual(["lsp"])
      expect(collection.map.get("grep_app").url).toBe("https://existing.invalid")
    })

    test("#then the registration dispose is propagated", async () => {
      const collection = fakeCollection()
      const disposer = async () => undefined
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection, disposer) }, { repoRoot: REPO, cwd: "/w", configDir: "/c", disabledMcps: [], retained: ["grep_app"], exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(result.dispose).toBe(disposer)
    })

    test("#then a host without mcp.transform degrades to an inert registration", async () => {
      expect(await registerNativeBuiltinMcps({}, {})).toEqual({ registered: [], dispose: undefined })
      expect(await registerNativeBuiltinMcps({ mcp: {} }, {})).toEqual({ registered: [], dispose: undefined })
    })
  })

  describe("#given resolveOpenCodeConfigDir #when resolving the config dir #then it stays on the isolated roots", () => {
    test("#then OPENCODE_CONFIG_DIR wins over XDG and XDG wins over the home default", () => {
      expect(resolveOpenCodeConfigDir({ OPENCODE_CONFIG_DIR: "/lab/config/opencode", XDG_CONFIG_HOME: "/lab/config" })).toBe("/lab/config/opencode")
      expect(resolveOpenCodeConfigDir({ XDG_CONFIG_HOME: "/lab/config" })).toBe(path.join("/lab/config", "opencode"))
      expect(resolveOpenCodeConfigDir({})).toBe(path.join(homedir(), ".config", "opencode"))
    })
  })

  test("#then the exported grep_app template stays the V1 remote definition", () => {
    expect(GREP_APP_MCP).toEqual({ type: "remote", url: "https://mcp.grep.app", disabled: false, oauth: false })
  })
})
