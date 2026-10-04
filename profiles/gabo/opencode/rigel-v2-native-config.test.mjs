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
import { resolveNativePluginConfig } from "./rigel-v2-native-config.mjs"

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
    expect(view.experimental).toEqual({ task_system: false })
    expect(view.disabled).toEqual({ tools: [], agents: [], skills: [] })
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
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(view.monitor.live_mode_enabled).toBe(true)
    expect(view.goal).toEqual({ enabled: true, auto_start: true, default_max_iterations: 7 })
    expect(view.experimental.task_system).toBe(true)
    expect(view.disabled).toEqual({ tools: ["todowrite"], agents: ["oracle"], skills: ["dev-browser"] })
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
