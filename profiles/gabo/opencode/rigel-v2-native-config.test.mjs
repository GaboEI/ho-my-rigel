/**
 * Owner tests for the native V2 configuration resolver.
 *
 * These pin the observable behavior Phase 3 gates depend on: which layer wins,
 * how disabled denylists union, how legacy keys migrate, how invalid values
 * degrade, and that pollution keys and unknown top-level keys never reach the
 * plugin view. A separate parity test pins the port against the real OmO loader.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deriveNativeGates,
  readNativeDisabled,
  readNativeGates,
  readNativeMcpPolicy,
  readNativePreemptiveThreshold,
  resolveNativePluginConfig,
} from "./rigel-v2-native-config.mjs"

const created = []

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), "rigel-native-config-"))
  const project = join(home, "project")
  mkdirSync(join(home, ".omo"), { recursive: true })
  mkdirSync(join(project, ".omo"), { recursive: true })
  created.push(home)
  const writeUser = (text) => writeFileSync(join(home, ".omo", "omo.jsonc"), text)
  const writeProject = (text) => writeFileSync(join(project, ".omo", "omo.jsonc"), text)
  const resolve = (env = {}) => resolveNativePluginConfig({
    directory: project,
    env: { HOME: home, USERPROFILE: home, ...env },
  })
  return { home, project, writeUser, writeProject, resolve }
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

describe("#given no configuration exists", () => {
  test("#when the view is resolved #then every gate is off and every denylist is empty", () => {
    // given
    const fixture = makeFixture()
    // when
    const view = fixture.resolve()
    // then
    // Parity with the real OmO loader: an absent key stays undefined; the
    // loader does not materialize schema defaults into the plugin view.
    expect(view.monitor).toBeUndefined()
    expect(view.goal).toBeUndefined()
    expect(view.experimental).toEqual({ task_system: false, preemptive_compaction: false, truncate_all_tool_outputs: false })
    expect(view.disabled).toEqual({ tools: [], agents: [], skills: [], hooks: [], commands: [] })
    expect(view.categories).toEqual({})
    expect(view.sources.every((source) => source.loaded === false)).toBe(true)
  })
})

describe("#given plugin keys at the top level of a layer", () => {
  test("#when the view is resolved #then unknown top-level keys are stripped like the real loader", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "monitor": { "enabled": true }, "goal": { "enabled": true } }`)
    // when
    const view = fixture.resolve()
    // then
    // The real loader strips plugin keys that sit at the top level of a layer
    // (they must live in the [opencode] block), so no gate is projected.
    expect(view.monitor).toBeUndefined()
    expect(view.goal).toBeUndefined()
  })
})

describe("#given plugin keys inside the [opencode] block", () => {
  test("#when the view is resolved #then every gate reflects the block", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": true, "live_mode_enabled": true },
        "goal": { "enabled": true, "auto_start": true, "default_max_iterations": 7 },
        "experimental": { "task_system": true },
        "disabled_tools": ["todowrite"],
        "disabled_agents": ["oracle"],
        "disabled_skills": ["dev-browser"],
        "disabled_commands": ["handoff"],
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(view.monitor.live_mode_enabled).toBe(true)
    expect(view.goal).toEqual({ enabled: true, auto_start: true, default_max_iterations: 7 })
    expect(view.experimental.task_system).toBe(true)
    expect(view.disabled).toEqual({ tools: ["todowrite"], agents: ["oracle"], skills: ["dev-browser"], hooks: [], commands: ["handoff"] })
  })
})

describe("#given the same section in two layers", () => {
  test("#when the nearer project layer sets monitor #then the later view replaces the whole section", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true, "live_mode_enabled": true } } }`)
    fixture.writeProject(`{ "[opencode]": { "monitor": { "enabled": false } } }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(false)
    expect(view.monitor.live_mode_enabled).toBe(false)
  })
})

describe("#given denylists in several layers", () => {
  test("#when the view is resolved #then the lists union in first-seen view order", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "profiles": { "gabo": { "[opencode]": { "disabled_tools": ["t3"] } } },
      "[opencode]": { "disabled_tools": ["t1"] },
    }`)
    fixture.writeProject(`{ "[opencode]": { "disabled_tools": ["t1", "t2"], "disabled_agents": ["a1", "a2"] } }`)
    // when
    const view = fixture.resolve({ OMO_PROFILE: "gabo" })
    // then
    expect(view.disabled.tools).toEqual(["t1", "t2", "t3"])
    expect(view.disabled.agents).toEqual(["a1", "a2"])
  })
})

describe("#given a selected profile", () => {
  test("#when OMO_PROFILE names any existing profile #then only that profile's block applies", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "profiles": {
        "gabo": { "[opencode]": { "monitor": { "enabled": true }, "goal": { "enabled": true } } },
        "other": { "[opencode]": { "monitor": { "enabled": true } } },
      },
    }`)
    // when
    const withoutProfile = fixture.resolve()
    const withGabo = fixture.resolve({ OMO_PROFILE: "gabo" })
    const withOther = fixture.resolve({ OMO_PROFILE: "other" })
    // then
    expect(withoutProfile.monitor).toBeUndefined()
    expect(withoutProfile.goal).toBeUndefined()
    expect(withGabo.monitor.enabled).toBe(true)
    expect(withGabo.goal.enabled).toBe(true)
    expect(withOther.monitor.enabled).toBe(true)
    expect(withOther.goal).toBeUndefined()
  })
})

describe("#given categories in several layers", () => {
  test("#when the view is resolved #then entries deep-merge and the legacy deep key is canonicalized", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "categories": { "quick": { "model": "top-quick", "temperature": 0.3 }, "deep": { "model": "top-deep" } },
      "[opencode]": { "categories": { "quick": { "top_p": 0.9 } } },
    }`)
    fixture.writeProject(`{ "[opencode]": { "categories": { "quick": { "model": "project-quick" }, "newcat": { "description": "n" } } } }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.categories.quick).toEqual({ model: "project-quick", temperature: 0.3, top_p: 0.9 })
    expect(view.categories["deep-low"]).toEqual({ model: "top-deep" })
    expect(view.categories.deep).toBeUndefined()
    expect(view.categories.newcat).toEqual({ description: "n" })
  })
})

describe("#given a legacy ralph_loop block", () => {
  test("#when the view is resolved #then it migrates into goal and explicit goal wins", () => {
    // given
    const migrated = makeFixture()
    migrated.writeUser(`{ "[opencode]": { "ralph_loop": { "enabled": true, "default_max_iterations": 42 } } }`)
    const explicit = makeFixture()
    explicit.writeUser(`{
      "[opencode]": {
        "ralph_loop": { "enabled": true, "default_max_iterations": 42 },
        "goal": { "enabled": false, "default_max_iterations": 9 },
      },
    }`)
    // when
    const migratedView = migrated.resolve()
    const explicitView = explicit.resolve()
    // then
    expect(migratedView.goal).toEqual({ enabled: true, auto_start: false, default_max_iterations: 42 })
    expect(explicitView.goal).toEqual({ enabled: false, auto_start: false, default_max_iterations: 9 })
  })
})

describe("#given invalid values", () => {
  test("#when the view is resolved #then each bad leaf is dropped with a warning and the rest survives", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": "yes", "max_runtime_ms": 5, "batch_max_lines": 12 },
        "experimental": { "task_system": "yes" },
        "disabled_tools": ["ok", 7],
        "categories": { "quick": { "model": 7, "temperature": 0.4 } },
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(false)
    expect(view.monitor.max_runtime_ms).toBe(1800000)
    expect(view.monitor.batch_max_lines).toBe(12)
    expect(view.experimental.task_system).toBe(false)
    expect(view.disabled.tools).toEqual(["ok"])
    expect(view.categories.quick).toEqual({ temperature: 0.4 })
    expect(view.diagnostics.some((line) => line.includes("monitor.enabled"))).toBe(true)
    expect(view.diagnostics.some((line) => line.includes("categories.quick.model"))).toBe(true)
  })
})

describe("#given a JSONC file", () => {
  test("#when the view is resolved #then comments and trailing commas are accepted", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      // the monitor gate
      "[opencode]": {
        /* inline */ "monitor": { "enabled": true, },
        "disabled_tools": ["a", "b",],
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(view.disabled.tools).toEqual(["a", "b"])
  })
})

describe("#given prototype-polluting keys", () => {
  test("#when the view is resolved #then unsafe keys never reach the object graph", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "__proto__": { "polluted": true }, "disabled_tools": ["safe"] } }`)
    // when
    fixture.resolve()
    // then
    expect({}.polluted).toBeUndefined()
  })
})

describe("#given a symlinked project .omo directory", () => {
  test("#when the view is resolved #then the project layer is refused and only the user layer loads", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true } } }`)
    const realDir = mkdtempSync(join(tmpdir(), "rigel-native-config-real-"))
    created.push(realDir)
    writeFileSync(join(realDir, "omo.jsonc"), `{ "[opencode]": { "monitor": { "enabled": false } } }`)
    rmSync(join(fixture.project, ".omo"), { recursive: true, force: true })
    symlinkSync(realDir, join(fixture.project, ".omo"))
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    const projectSources = view.sources.filter((source) => source.scope === "project")
    expect(projectSources.every((source) => source.loaded === false)).toBe(true)
  })
})

describe("#given an injected file system", () => {
  test("#when the view is resolved #then no real disk is read", () => {
    // given
    const files = new Map([
      ["/virtual/.omo/omo.jsonc", `{ "[opencode]": { "monitor": { "enabled": true }, "disabled_tools": ["x"] } }`],
    ])
    const fileSystem = {
      existsSync: (path) => files.has(path),
      readFileSync: (path) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
        return files.get(path)
      },
      lstatSync: () => ({ isSymbolicLink: () => false }),
      realpathSync: (path) => path,
    }
    // when
    const view = resolveNativePluginConfig({
      directory: "/virtual/project",
      env: { HOME: "/virtual", USERPROFILE: "/virtual" },
      fileSystem,
    })
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(view.disabled.tools).toEqual(["x"])
    expect(view.sources.find((source) => source.scope === "user").loaded).toBe(true)
  })
})

describe("#given a resolved native plugin config view", () => {
  test("#when gates are derived #then they mirror the config keys and permit interactive_bash unless disabled", () => {
    // given
    const off = { monitor: undefined, goal: { enabled: false }, experimental: { task_system: false }, disabled: { tools: [] } }
    // when
    const offGates = deriveNativeGates(off)
    // then
    expect(offGates).toEqual({ monitor: false, goal: false, task_system: false, team_mode: false, interactive_bash: true, hashline_edit: false, preemptive_compaction: false })

    // given
    const on = { monitor: { enabled: true }, goal: { enabled: true }, experimental: { task_system: true }, team_mode: { enabled: true }, disabled: { tools: [] } }
    // when
    const onGates = deriveNativeGates(on)
    // then
    expect(onGates).toEqual({ monitor: true, goal: true, task_system: true, team_mode: true, interactive_bash: true, hashline_edit: false, preemptive_compaction: false })

    // given
    const disabled = { monitor: { enabled: true }, goal: { enabled: true }, experimental: { task_system: true }, disabled: { tools: ["interactive_bash"] } }
    // when
    const disabledGates = deriveNativeGates(disabled)
    // then
    expect(disabledGates).toEqual({ monitor: true, goal: true, task_system: true, team_mode: false, interactive_bash: false, hashline_edit: false, preemptive_compaction: false })
  })

  test("#when preemptive_compaction is set #then the gate is on and the threshold is projected", () => {
    // given
    const view = { monitor: undefined, goal: undefined, experimental: { task_system: false, preemptive_compaction: true, preemptive_compaction_threshold: 0.5 }, disabled: { tools: [] } }
    // when
    const gates = deriveNativeGates(view)
    // then
    expect(gates.preemptive_compaction).toBe(true)
    // Off unless explicitly true: the V1 default.
    expect(deriveNativeGates({ experimental: { preemptive_compaction: "yes" } }).preemptive_compaction).toBe(false)
  })

  test("#when the view is malformed #then every config gate degrades closed", () => {
    // given / when
    const gates = deriveNativeGates(undefined)
    // then
    expect(gates.monitor).toBe(false)
    expect(gates.goal).toBe(false)
    expect(gates.task_system).toBe(false)
  })
})

describe("#given a materialized manifest", () => {
  test("#when the disabled denylists are materialized #then readNativeDisabled returns normalized arrays", () => {
    // given
    const manifest = { metadata: { global: { disabled: { tools: ["x", 1], agents: [], skills: ["dev-browser", "ultimate-browsing"] } } } }
    // when
    const disabled = readNativeDisabled(manifest)
    // then
    expect(disabled.tools).toEqual(["x"])
    expect(disabled.skills).toEqual(["dev-browser", "ultimate-browsing"])
  })

  test("#when the manifest carries no denylists #then every list is empty", () => {
    // given / when / then
    expect(readNativeDisabled(undefined)).toEqual({ tools: [], agents: [], skills: [], hooks: [], commands: [] })
    expect(readNativeDisabled({ metadata: { global: {} } })).toEqual({ tools: [], agents: [], skills: [], hooks: [], commands: [] })
  })
})


describe("#given the T34 preemptive compaction gate", () => {
  test("#when the block sets the gate and threshold #then the view projects both", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "experimental": { "preemptive_compaction": true, "preemptive_compaction_threshold": 0.9 },
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.experimental.preemptive_compaction).toBe(true)
    expect(view.experimental.preemptive_compaction_threshold).toBe(0.9)
    expect(deriveNativeGates(view).preemptive_compaction).toBe(true)
  })

  test("#when the threshold is out of range #then it is dropped but the gate survives", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "experimental": { "preemptive_compaction": true, "preemptive_compaction_threshold": 1.5 },
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.experimental.preemptive_compaction).toBe(true)
    expect(view.experimental.preemptive_compaction_threshold).toBeUndefined()
  })

  test("#when the manifest materializes the gate #then readNativeGates and the threshold reader agree", () => {
    // given
    const manifest = { metadata: { global: { gates: { preemptive_compaction: true }, preemptiveCompactionThreshold: 0.42 } } }
    // when / then
    expect(readNativeGates(manifest).preemptive_compaction).toBe(true)
    expect(readNativePreemptiveThreshold(manifest)).toBe(0.42)
    // An absent or out-of-range threshold falls back to the V1 0.78 default.
    expect(readNativePreemptiveThreshold({ metadata: { global: {} } })).toBeUndefined()
    expect(readNativePreemptiveThreshold({ metadata: { global: { preemptiveCompactionThreshold: 2 } } })).toBeUndefined()
    expect(readNativeGates({ metadata: { global: { gates: {} } } }).preemptive_compaction).toBe(false)
  })
})

describe("#given the tier-2 MCP policy", () => {
  test("#when the manifest carries the mcp block #then readNativeMcpPolicy normalizes it", () => {
    // given
    const manifest = { metadata: { global: { mcp: { disabled: ["context7", 3], envAllowlist: ["QA_MCP_TOKEN"] } } } }
    // when
    const policy = readNativeMcpPolicy(manifest)
    // then
    expect(policy).toEqual({ disabled: ["context7"], envAllowlist: ["QA_MCP_TOKEN"] })
    expect(readNativeMcpPolicy(undefined)).toEqual({ disabled: [], envAllowlist: [] })
  })

  test("#when a project layer extends mcp_env_allowlist #then only the user layer allowlist survives", () => {
    // given
    const fs = require("node:fs")
    const os = require("node:os")
    const path = require("node:path")
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-allowlist-"))
    const project = path.join(home, "proj")
    fs.mkdirSync(path.join(project, ".omo"), { recursive: true })
    fs.mkdirSync(path.join(home, ".omo"), { recursive: true })
    fs.writeFileSync(path.join(home, ".omo", "omo.jsonc"), JSON.stringify({ mcp_env_allowlist: ["USER_VAR"] }))
    fs.writeFileSync(path.join(project, ".omo", "omo.jsonc"), JSON.stringify({ mcp_env_allowlist: ["PROJECT_VAR"], disabled_mcps: ["context7"] }))
    try {
      // when
      const view = resolveNativePluginConfig({ directory: project, env: { ...process.env, HOME: home }, fileSystem: { existsSync: (p) => fs.existsSync(p), readFileSync: (p) => fs.readFileSync(p, "utf8") } })
      // then: the user-only security rule holds; disabled_mcps unions normally
      expect(view.mcp_env_allowlist).toEqual(["USER_VAR"])
      expect(view.disabled_mcps).toEqual(["context7"])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
