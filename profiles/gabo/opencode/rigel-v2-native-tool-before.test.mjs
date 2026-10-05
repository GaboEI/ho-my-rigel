import { expect, test } from "bun:test"
import { createNativeToolBeforeRules } from "./rigel-v2-native-tool-before.mjs"

test("native tool-before rules normalize MCP and bash inputs while rejecting manual background polling", () => {
  const rules = createNativeToolBeforeRules({ backgroundManager: { activeCount: () => 1 } })
  const mcp = { tool: "mcp_search", input: {} }
  const bash = { tool: "bash", input: { command: "printf 'a\0b'" } }
  const sleep = { tool: "bash", sessionID: "ses_1", input: { command: "sleep 1" } }

  rules.find((rule) => rule.name === "mcp-prefix-strip").run(mcp)
  rules.find((rule) => rule.name === "bash-null-byte-strip").run(bash)

  expect(mcp.tool).toBe("search")
  expect(bash.input.command).toBe("printf 'ab'")
  expect(() => rules.find((rule) => rule.name === "background-sleep-block").run(sleep)).toThrow("Background task wait is already managed")
})
