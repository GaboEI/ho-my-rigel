import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  SCOPE_PRIORITY,
  collectDisabledSkillAliases,
  discoverSkills,
  findPartialSkillMatches,
  formatSkillInjection,
  getAgentConfigKey,
  isSkillAllowedForTargetAgent,
  matchSkillByName,
  parseFrontmatter,
  registerNativeSkills,
  selectSkillsForChild,
} from "./rigel-v2-native-skills.mjs"

const temporaryRoots = []

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-skills-"))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function writeSkill(baseDir, relativeDir, name, { frontmatter = "", body = "" } = {}) {
  const dir = path.join(baseDir, relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : ""
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${fm}${body}\n`, "utf8")
  return dir
}

describe("#given a SKILL.md frontmatter payload", () => {
  test("#when parsed #then scalar, inline-array, metadata, and nested mcp fields are all read", () => {
    const content = [
      "---",
      "name: demo",
      "description: A demo skill",
      "agent: oracle",
      "allowed-tools: [Read, Write]",
      "metadata:",
      "  category: test",
      "mcp:",
      "  memory:",
      "    command: npx",
      "    args: [-y, server]",
      "    env:",
      "      MODE: strict",
      "---",
      "",
      "Body line one.",
    ].join("\n")
    const { data, body } = parseFrontmatter(content)
    expect(data.name).toBe("demo")
    expect(data.description).toBe("A demo skill")
    expect(data.agent).toBe("oracle")
    expect(data["allowed-tools"]).toEqual(["Read", "Write"])
    expect(data.metadata).toEqual({ category: "test" })
    expect(data.mcp.memory.command).toBe("npx")
    expect(data.mcp.memory.args).toEqual(["-y", "server"])
    expect(data.mcp.memory.env).toEqual({ MODE: "strict" })
    expect(body.trim()).toBe("Body line one.")
  })

  test("#when there is no frontmatter #then the whole document is the body", () => {
    const { data, body, hadFrontmatter } = parseFrontmatter("just text")
    expect(hadFrontmatter).toBe(false)
    expect(data).toEqual({})
    expect(body).toBe("just text")
  })
})

describe("#given skills in multiple scope directories", () => {
  test("#when the same name exists in project and user scope #then the higher scope priority wins", () => {
    const root = makeRoot()
    const home = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/shared", "shared", { frontmatter: "name: shared\ndescription: project copy", body: "PROJECT_BODY" })
    writeSkill(home, ".claude/skills/shared", "shared", { frontmatter: "name: shared\ndescription: user copy", body: "USER_BODY" })
    const skills = discoverSkills({ directory: projectDir, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } })
    const winner = matchSkillByName(skills, "shared")
    expect(winner.scope).toBe("project")
    expect(winner.rawBody).toBe("PROJECT_BODY")
    expect(SCOPE_PRIORITY.project).toBeGreaterThan(SCOPE_PRIORITY.user)
  })

  test("#when two nested skills share a short name #then an ambiguous short name refuses to resolve but an exact name does", () => {
    const skills = [
      { name: "alpha/thing", rawBody: "A", resolvedBody: "A", scope: "project" },
      { name: "beta/thing", rawBody: "B", resolvedBody: "B", scope: "project" },
    ]
    expect(matchSkillByName(skills, "thing")).toBeUndefined()
    expect(matchSkillByName(skills, "beta/thing").rawBody).toBe("B")
    expect(matchSkillByName(skills, "/alpha/thing").rawBody).toBe("A")
  })
})

describe("#given agent-restricted and disabled skills", () => {
  test("#when the target agent matches #then the skill is allowed; otherwise it is not", () => {
    expect(getAgentConfigKey("Sisyphus - ultraworker")).toBe("sisyphus")
    expect(getAgentConfigKey("oracle")).toBe("oracle")
    const skill = { name: "s", agent: "oracle" }
    expect(isSkillAllowedForTargetAgent(skill, "oracle")).toBe(true)
    expect(isSkillAllowedForTargetAgent(skill, "Sisyphus - ultraworker")).toBe(false)
    expect(isSkillAllowedForTargetAgent(skill, undefined)).toBe(false)
    expect(isSkillAllowedForTargetAgent({ name: "open" }, undefined)).toBe(true)
  })

  test("#when disabled_skills and skills.disable both name a skill #then aliases are collected case-insensitively", () => {
    const disabled = collectDisabledSkillAliases({ disabled_skills: ["Foo"], skills: { disable: ["bar"], baz: false } })
    expect(disabled.has("foo")).toBe(true)
    expect(disabled.has("bar")).toBe(true)
    expect(disabled.has("baz")).toBe(true)
  })
})

describe("#given requested skills for a delegated child", () => {
  test("#when a name resolves #then the real body is injected and a missing name keeps the textual fallback", () => {
    const skills = [
      { name: "review-work", rawBody: "REAL_REVIEW_BODY", scope: "project", agent: undefined },
      { name: "oracle-only", rawBody: "ORACLE_BODY", scope: "project", agent: "oracle" },
    ]
    const resolved = selectSkillsForChild(skills, ["review-work", "ghost", "oracle-only"], { targetAgent: "explore" })
    expect(resolved.injected).toEqual([{ name: "review-work", body: "REAL_REVIEW_BODY" }])
    expect(resolved.missing).toEqual(["ghost", "oracle-only"])
    const injected = formatSkillInjection(resolved)
    expect(injected).toContain("<skill name=\"review-work\">")
    expect(injected).toContain("REAL_REVIEW_BODY")
    expect(injected).toContain("<rigel-requested-skills>Before working, load these native skills if available: ghost, oracle-only</rigel-requested-skills>")
  })

  test("#when a name is disabled #then it is reported missing instead of injected", () => {
    const skills = [{ name: "blocked", rawBody: "SECRET", scope: "project" }]
    const resolved = selectSkillsForChild(skills, ["blocked"], { disabledSkills: new Set(["blocked"]) })
    expect(resolved.injected).toEqual([])
    expect(resolved.missing).toEqual(["blocked"])
  })

  test("#when the same name exists at two scopes #then the discovered winner's body wins the collision", () => {
    const root = makeRoot()
    const home = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/collision", "collision", { frontmatter: "name: collision\ndescription: project", body: "PROJECT_WINS" })
    writeSkill(home, ".claude/skills/collision", "collision", { frontmatter: "name: collision\ndescription: user", body: "USER_LOSES" })
    const skills = discoverSkills({ directory: projectDir, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } })
    const resolved = selectSkillsForChild(skills, ["collision"], { targetAgent: "explore" })
    expect(resolved.injected[0].body).toBe("PROJECT_WINS")
  })

  test("#when partial matches exist #then they are offered for the error path", () => {
    const skills = [{ name: "review-work" }, { name: "review-tests" }]
    expect(findPartialSkillMatches(skills, "review")).toEqual(["review-work", "review-tests"])
  })
})

describe("#given the V2 native skill surface", () => {
  test("#when registering #then each discovered skill becomes an embedded SkillV2Info and host names are preserved", async () => {
    const root = makeRoot()
    const home = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/alpha", "alpha", { frontmatter: "name: alpha\ndescription: Alpha skill", body: "ALPHA_BODY" })
    writeSkill(projectDir, ".agents/skills/host-skill", "host-skill", { frontmatter: "name: host-skill\ndescription: Host", body: "HOST_BODY" })
    const added = []
    const hostNames = [{ name: "host-skill" }]
    const context = {
      location: { directory: projectDir },
      skill: { transform: async (callback) => { callback({ add: (info) => added.push(info), list: () => hostNames }); return { dispose() {} } } },
      options: { skillsHome: home, skillsEnv: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } },
    }
    const registry = await registerNativeSkills(context, { directory: projectDir, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } })
    expect(registry.skills.map((skill) => skill.name).sort()).toEqual(["alpha", "host-skill"])
    expect(added).toEqual([{ id: "alpha", name: "alpha", description: "Alpha skill", path: path.join(projectDir, ".agents/skills/alpha", "SKILL.md"), content: "ALPHA_BODY" }])
    expect(registry.registered).toEqual(["alpha"])
  })

  test("#when the host exposes source() instead of add() #then registration still lands as an embedded source", async () => {
    const root = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/beta", "beta", { frontmatter: "name: beta\ndescription: Beta", body: "BETA_BODY" })
    const sources = []
    const context = {
      location: { directory: projectDir },
      skill: { transform: async (callback) => { callback({ source: (source) => sources.push(source), list: () => [] }); return { dispose() {} } } },
      options: { skillsHome: root, skillsEnv: { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") } },
    }
    await registerNativeSkills(context, { directory: projectDir, home: root, env: { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") } })
    expect(sources).toEqual([{ type: "embedded", skill: { id: "beta", name: "beta", description: "Beta", path: path.join(projectDir, ".agents/skills/beta", "SKILL.md"), content: "BETA_BODY" } }])
  })
})
