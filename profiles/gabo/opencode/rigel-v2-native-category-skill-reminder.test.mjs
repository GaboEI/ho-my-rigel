import { describe, expect, test } from "bun:test"
import { createNativeCategorySkillReminder } from "./rigel-v2-native-category-skill-reminder.mjs"

const MARKER = "[Category+Skill Reminder]"

function agentResolver(agentsBySession) {
  return ({ sessionID }) => agentsBySession[sessionID]
}

async function useTools(hook, sessionID, tools, agent) {
  for (const tool of tools) {
    await hook.after({ tool, sessionID, agent })
  }
}

function expectedMessage({ builtinText, customText, loadSkills }) {
  return [
    "",
    MARKER,
    "",
    `**Built-in**: ${builtinText}`,
    `**⚡ YOUR SKILLS (PRIORITY)**: ${customText}`,
    "",
    "> User-installed skills OVERRIDE built-in defaults. ALWAYS prefer YOUR SKILLS when domain matches.",
    "",
    "```typescript",
    `task(category=\"visual-engineering\", load_skills=${loadSkills}, run_in_background=true)`,
    "```",
    "",
  ].join("\n")
}

describe("native category-skill reminder: threshold and targeting", () => {
  test.each([
    "sisyphus",
    "sisyphus-junior",
    "atlas",
    "Sisyphus - ultraworker",
    "3|Sisyphus",
    "Atlas - Plan Executor",
  ])("#given target agent %s #when three delegatable tools finish #then a pending reminder is armed", async (agent) => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => agent })

    await useTools(hook, `ses-${agent}`, ["edit", "bash", "write"])

    const pending = hook.pending(`ses-${agent}`)
    expect(pending).not.toBe("")
    expect(pending).toContain(MARKER)
  })

  test("#given a target agent inline on the event #when three delegatable tools finish #then the reminder is armed", async () => {
    const hook = createNativeCategorySkillReminder()

    await useTools(hook, "ses-inline", ["read", "grep", "glob"], "Sisyphus")

    expect(hook.pending("ses-inline")).toContain(MARKER)
  })

  test("#given an async session-agent resolver #when three delegatable tools finish #then the reminder is armed", async () => {
    const hook = createNativeCategorySkillReminder({
      getAgent: async ({ sessionID }) => (sessionID === "ses-async" ? "Atlas - Plan Executor" : undefined),
    })

    await useTools(hook, "ses-async", ["edit", "edit", "edit"])

    expect(hook.pending("ses-async")).toContain(MARKER)
  })

  test("#given fewer than three delegatable tools #when they finish #then nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-two", ["edit", "read"])

    expect(hook.pending("ses-two")).toBe("")
  })

  test("#given non-listed tools #when many finish #then the counter is untouched and nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-ignored", ["lsp_symbols", "lsp_goto_definition", "todowrite", "webfetch", "skill"])

    expect(hook.pending("ses-ignored")).toBe("")
  })

  test("#given a non-target agent #when three delegatable tools finish #then nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "librarian" })

    await useTools(hook, "ses-librarian", ["edit", "edit", "edit"])

    expect(hook.pending("ses-librarian")).toBe("")
  })

  test("#given no resolvable agent #when three delegatable tools finish #then nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => undefined })

    await useTools(hook, "ses-anon", ["edit", "edit", "edit"])

    expect(hook.pending("ses-anon")).toBe("")
  })

  test("#given a target agent #when the threshold is reached #then the tool output is not mutated", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    const event = { tool: "read", sessionID: "ses-bytes", agent: "Sisyphus", result: { content: "original\r\nbytes\u0000" } }

    await hook.after(event)
    await hook.after(event)
    await hook.after(event)

    expect(event.result.content).toBe("original\r\nbytes\u0000")
    expect(hook.pending("ses-bytes")).toContain(MARKER)
  })
})

describe("native category-skill reminder: delegation suppression", () => {
  test.each([
    { tool: "task", order: "before", tools: ["task", "edit", "edit", "edit"] },
    { tool: "task", order: "after", tools: ["edit", "edit", "edit", "task"] },
    { tool: "call_omo_agent", order: "before", tools: ["call_omo_agent", "edit", "edit", "edit"] },
    { tool: "call_omo_agent", order: "after", tools: ["edit", "edit", "edit", "call_omo_agent"] },
    { tool: "rigel_task", order: "before", tools: ["rigel_task", "read", "grep", "glob"] },
    { tool: "rigel_task", order: "after", tools: ["read", "grep", "glob", "rigel_task"] },
  ])("#given $tool finishes $order the threshold #when the sequence completes #then nothing is pending", async ({ tools }) => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-delegation", tools)

    expect(hook.pending("ses-delegation")).toBe("")
  })

  test("#given a delegation tool already used #when the threshold is reached again #then delegation stays suppressed", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-locked", ["task"])
    await useTools(hook, "ses-locked", ["edit", "edit", "edit"])
    await useTools(hook, "ses-locked", ["read", "read", "read"])

    expect(hook.pending("ses-locked")).toBe("")
  })
})

describe("native category-skill reminder: once per session and clear", () => {
  test("#given an armed reminder #when consumed #then pending clears and a later threshold stays empty", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-once", ["edit", "write", "bash"])

    const armed = hook.pending("ses-once")
    const consumed = hook.consume("ses-once")

    expect(armed).toContain(MARKER)
    expect(consumed).toBe(armed)
    expect(hook.pending("ses-once")).toBe("")
    expect(hook.consume("ses-once")).toBe("")

    await useTools(hook, "ses-once", ["edit", "write", "bash"])
    expect(hook.pending("ses-once")).toBe("")
  })

  test("#given a consumed reminder #when delegatable tools finish #then the session is not re-armed", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-consumed", ["read", "read", "read"])
    hook.consume("ses-consumed")

    await useTools(hook, "ses-consumed", ["read", "read", "read", "read"])

    expect(hook.pending("ses-consumed")).toBe("")
  })

  test("#given an armed reminder #when the session is cleared #then a fresh threshold re-arms it", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-clear", ["edit", "edit", "edit"])
    expect(hook.pending("ses-clear")).toContain(MARKER)

    hook.clear("ses-clear")
    expect(hook.pending("ses-clear")).toBe("")

    await useTools(hook, "ses-clear", ["edit", "edit", "edit"])
    expect(hook.pending("ses-clear")).toContain(MARKER)
  })

  test("#given state in multiple sessions #when only one is cleared #then the others keep their state", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-a", ["edit", "edit", "edit"])
    await useTools(hook, "ses-b", ["edit", "edit", "edit"])

    hook.clear("ses-a")

    expect(hook.pending("ses-a")).toBe("")
    expect(hook.pending("ses-b")).toContain(MARKER)

    hook.clearAll()
    expect(hook.pending("ses-b")).toBe("")
  })
})

describe("native category-skill reminder: byte-exact formatter", () => {
  test("#given built-in skills #when the reminder fires #then built-in names fill the Built-in line and load_skills picks the first built-in", async () => {
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [
        { name: "frontend", location: "plugin" },
        { name: "git-master", location: "builtin" },
      ],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-builtin", ["read", "read", "read"])

    const message = hook.pending("ses-builtin")
    expect(message).toBe(expectedMessage({
      builtinText: "frontend, git-master",
      customText: "(none)",
      loadSkills: `[\"frontend\"]`,
    }))
    expect(message).toContain("**Built-in**: frontend, git-master")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: (none)")
  })

  test("#given a user skill beside a built-in #when the reminder fires #then the user skill leads YOUR SKILLS and load_skills", async () => {
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [
        { name: "frontend", location: "plugin" },
        { name: "react-19", location: "user" },
      ],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-custom", ["read", "read", "read"])

    const message = hook.pending("ses-custom")
    expect(message).toBe(expectedMessage({
      builtinText: "frontend",
      customText: "react-19",
      loadSkills: `[\"react-19\"]`,
    }))
    expect(message).toContain("**Built-in**: frontend")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: react-19")
    expect(message).toContain('task(category="visual-engineering", load_skills=["react-19"], run_in_background=true)')
  })

  test("#given no skills #when the reminder fires #then both lists read (none) and load_skills is empty", async () => {
    const hook = createNativeCategorySkillReminder({ getSkills: () => [], getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-none", ["read", "read", "read"])

    const message = hook.pending("ses-none")
    expect(message).toBe(expectedMessage({ builtinText: "(none)", customText: "(none)", loadSkills: "[]" }))
    expect(message).toContain("**Built-in**: (none)")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: (none)")
    expect(message).toContain("load_skills=[], run_in_background=true")
  })

  test("#given more than eight skills in a list #when formatted #then only eight show and the count is appended", async () => {
    const builtin = Array.from({ length: 10 }, (_value, index) => ({ name: `builtin-${index + 1}`, location: "plugin" }))
    const custom = Array.from({ length: 9 }, (_value, index) => ({ name: `custom-${index + 1}`, location: "user" }))
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [...builtin, ...custom],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-more", ["read", "read", "read"])

    const message = hook.pending("ses-more")
    expect(message).toContain("**Built-in**: builtin-1, builtin-2, builtin-3, builtin-4, builtin-5, builtin-6, builtin-7, builtin-8 (+2 more)")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: custom-1, custom-2, custom-3, custom-4, custom-5, custom-6, custom-7, custom-8 (+1 more)")
    expect(message).toContain("load_skills=[\"custom-1\"]")
  })

  test("#given skills with no location or source #when classified #then they count as user skills", async () => {
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [{ name: "loose" }],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-loose", ["read", "read", "read"])

    const message = hook.pending("ses-loose")
    expect(message).toContain("**Built-in**: (none)")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: loose")
  })
})
