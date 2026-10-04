import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "./rigel-v2-native.mjs"

const temporaryRoots = []

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-skills-injection-"))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function writeSkill(baseDir, relativeDir, name, { frontmatter = "", body = "" } = {}) {
  const dir = path.join(baseDir, relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter ? `---\n${frontmatter}\n---\n` : ""}${body}\n`, "utf8")
}

function makeContext({ projectDir, home, prompts, tools, nativeSkills }) {
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") }
  return {
    location: { directory: projectDir },
    options: { skillsHome: home, skillsEnv: env },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "explore", mode: "subagent" }] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async (input) => { prompts.push(input); return { data: {} } },
      context: async () => [],
    },
    skill: {
      transform: async (callback) => { callback({ add: (info) => nativeSkills.push(info), list: () => [] }); return { dispose() {} } },
    },
    tool: {
      transform: async (callback) => { callback({ add: (definition) => tools.push(definition) }); return { dispose() {} } },
    },
  }
}

describe("#given a delegated child that requests skills", () => {
  test("#when the skill resolves #then the child prompt carries the real body, not a textual pointer", async () => {
    const home = makeRoot()
    const projectDir = makeRoot()
    writeSkill(projectDir, ".agents/skills/injected-skill", "injected-skill", {
      frontmatter: "name: injected-skill\ndescription: Injected body",
      body: "REAL_SKILL_BODY_MARKER",
    })
    const prompts = []
    const tools = []
    const native = []
    const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: native })
    const dispose = await plugin.setup(context)
    const task = tools.find((definition) => definition.name === "rigel_task")
    expect(task).toBeDefined()
    expect(tools.some((definition) => definition.name === "skill_mcp")).toBe(true)

    await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["injected-skill"], run_in_background: true }, { sessionID: "ses_parent" })
    const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
    expect(childPrompt.text).toContain("<skill name=\"injected-skill\">")
    expect(childPrompt.text).toContain("REAL_SKILL_BODY_MARKER")
    expect(childPrompt.text).not.toContain("<rigel-requested-skills>")
    await dispose()
  })

  test("#when a requested name cannot be resolved #then the textual fallback survives instead of a silent drop", async () => {
    const home = makeRoot()
    const projectDir = makeRoot()
    const prompts = []
    const tools = []
    const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: [] })
    // A discovered skill is required for the runtime to expose rigel_task with a non-empty registry; add one unrelated skill.
    writeSkill(projectDir, ".agents/skills/present", "present", { frontmatter: "name: present\ndescription: Present", body: "PRESENT_BODY" })
    const dispose = await plugin.setup(context)
    const task = tools.find((definition) => definition.name === "rigel_task")
    await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["ghost"], run_in_background: true }, { sessionID: "ses_parent" })
    const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
    expect(childPrompt.text).toContain("<rigel-requested-skills>Before working, load these native skills if available: ghost</rigel-requested-skills>")
    await dispose()
  })

  test("#when a skill is restricted to another agent #then its body is withheld and the fallback names it", async () => {
    const home = makeRoot()
    const projectDir = makeRoot()
    writeSkill(projectDir, ".agents/skills/oracle-only", "oracle-only", {
      frontmatter: "name: oracle-only\ndescription: Oracle only\nagent: oracle",
      body: "ORACLE_SECRET_BODY",
    })
    const prompts = []
    const tools = []
    const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: [] })
    const dispose = await plugin.setup(context)
    const task = tools.find((definition) => definition.name === "rigel_task")
    await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["oracle-only"], run_in_background: true }, { sessionID: "ses_parent" })
    const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
    expect(childPrompt.text).not.toContain("ORACLE_SECRET_BODY")
    expect(childPrompt.text).toContain("oracle-only")
    await dispose()
  })
})
