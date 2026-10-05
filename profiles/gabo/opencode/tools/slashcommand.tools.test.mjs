import { describe, expect, test } from "bun:test"
import { createSlashcommandTool, formatCommandCatalog } from "./slashcommand.tools.mjs"

describe("native slashcommand tool", () => {
  test("renders the host command catalog with names and descriptions", async () => {
    // given
    const tool = createSlashcommandTool({ listCommands: async () => [
      { name: "goal", description: "Set, pause, resume, clear, or show the current session goal." },
      { name: "ulw-execute", description: "Run a work plan." },
      { name: "compact" },
    ] })
    // when
    const result = await tool.execute({})
    // then
    expect(result.content.split("\n")).toEqual([
      "- /goal: Set, pause, resume, clear, or show the current session goal.",
      "- /ulw-execute: Run a work plan.",
      "- /compact",
    ])
  })

  test("unwraps the SDK response shape and drops malformed entries", async () => {
    const tool = createSlashcommandTool({ listCommands: async () => ({ data: [
      { name: "/goal", description: "Goal" },
      { description: "no name" },
      null,
    ] }) })
    const result = await tool.execute({})
    expect(result.content).toBe("- /goal: Goal")
  })

  test("an empty catalog is reported instead of returning an empty string", async () => {
    const tool = createSlashcommandTool({ listCommands: async () => [] })
    const result = await tool.execute({})
    expect(result.content).toBe("No slash commands are registered in the host.")
  })

  test("the factory refuses to build without a command domain", () => {
    expect(() => createSlashcommandTool({})).toThrow("command list function is required")
  })

  test("formatCommandCatalog is stable for a direct call", () => {
    expect(formatCommandCatalog([{ name: "/a", description: " b " }])).toBe("- /a: b")
  })
})
