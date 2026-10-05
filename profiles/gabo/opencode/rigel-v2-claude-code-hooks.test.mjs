import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createNativeContextCollector } from "./rigel-v2-context-collector.mjs"
import { createNativeClaudeCodeHooks } from "./rigel-v2-claude-code-hooks.mjs"

test("native Claude Code hooks dispatch every V2 lifecycle and register prompt output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rigel-claude-hooks-"))
  const log = path.join(directory, "events.log")
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const hook = (event) => ({ hooks: [{ type: "command", command: `printf ${quote(event)} >> ${quote(log)}` }] })
  await fs.mkdir(path.join(directory, ".claude"), { recursive: true })
  await fs.writeFile(path.join(directory, ".claude", "settings.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ matcher: ".*", hooks: [{ type: "command", command: "grep -q '\"transcript\"' && printf prompt-context" }] }],
    PreToolUse: [hook("pre\n")], PostToolUse: [hook("post\n")], PreCompact: [hook("compact\n")],
    SessionStart: [hook("start\n")], Stop: [hook("stop\n")],
  } }))
  const handlers = {}
  const context = {
    location: { directory },
    session: {
      hook: async (name, handler) => { handlers[name] = handler; return { dispose() {} } },
      context: async () => [{ role: "user", content: "transcript" }],
    },
    tool: { hook: async (name, handler) => { handlers[`tool.${name}`] = handler; return { dispose() {} } } },
  }
  const collector = createNativeContextCollector()
  const runtime = createNativeClaudeCodeHooks({ context, collector, directory })
  const dispose = await runtime.install()
  await handlers.prompt({ sessionID: "ses_root", prompt: { text: "work" } })
  await handlers.compaction({ sessionID: "ses_root" })
  await handlers["tool.execute.before"]({ sessionID: "ses_root", tool: "read", input: { path: "file" } })
  await handlers["tool.execute.after"]({ sessionID: "ses_root", tool: "read", output: "ok" })
  await runtime.handleEvent({ type: "session.created", sessionID: "ses_root" })
  await runtime.handleEvent({ type: "session.idle", sessionID: "ses_root" })
  expect(collector.getPending("ses_root")).toMatchObject({ hasContent: true, merged: "prompt-context", entries: [expect.objectContaining({ source: "custom", priority: "high" })] })
  expect((await fs.readFile(log, "utf8")).trim().split("\n").sort()).toEqual(["compact", "post", "pre", "start", "stop"])
  await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(directory, ".opencode", "opencode-cc-plugin.json"), JSON.stringify({ disabledHooks: { PreToolUse: ["events.log"] } }))
  await handlers["tool.execute.before"]({ sessionID: "ses_root", tool: "read", input: { path: "disabled" } })
  expect((await fs.readFile(log, "utf8")).trim().split("\n").sort()).toEqual(["compact", "post", "pre", "start", "stop"])
  dispose()
  await fs.rm(directory, { recursive: true, force: true })
})
