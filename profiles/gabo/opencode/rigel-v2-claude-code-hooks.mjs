import {
  loadNativeClaudeCodeHooksConfig,
  loadNativeClaudeCodePluginConfig,
  matchingNativeClaudeHooks,
  nativeClaudeHookDisabled,
} from "./rigel-v2-claude-code-config.mjs"

export async function readNativeClaudeTranscript(context, sessionID) {
  if (typeof context?.session?.context !== "function" || typeof sessionID !== "string") return []
  const result = await context.session.context({ sessionID })
  return Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : [])
}

async function dispatchHook(hook, payload, directory) {
  if (hook?.type === "http" && typeof hook.url === "string") {
    const response = await fetch(hook.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    return { exitCode: response.ok ? 0 : 1, stdout: await response.text(), stderr: response.statusText }
  }
  if (hook?.type !== "command" || typeof hook.command !== "string") return { exitCode: 0, stdout: "", stderr: "" }
  const process = Bun.spawn(["/bin/sh", "-lc", hook.command], {
    cwd: directory,
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  }
}

function hookOutput(stdout) {
  const text = stdout.trim()
  return text || undefined
}

export function createNativeClaudeCodeHooks({ context, collector, directory = context?.location?.directory } = {}) {
  async function dispatch(eventName, event, subject = "") {
    const [config, pluginConfig] = await Promise.all([
      loadNativeClaudeCodeHooksConfig({ directory }),
      loadNativeClaudeCodePluginConfig({ directory }),
    ])
    const payload = {
      session_id: event?.sessionID,
      cwd: directory,
      hook_event_name: eventName,
      session: { id: event?.sessionID },
      tool_name: event?.tool,
      tool_input: event?.input,
      tool_response: event?.output,
      prompt: event?.prompt?.text ?? event?.prompt,
      transcript: await readNativeClaudeTranscript(context, event?.sessionID),
      hook_source: "opencode-plugin",
    }
    const messages = []
    for (const hook of matchingNativeClaudeHooks(config, eventName, subject)) {
      if (nativeClaudeHookDisabled(pluginConfig, eventName, hook)) continue
      const result = await dispatchHook(hook, payload, directory)
      const output = hookOutput(result.stdout)
      if (eventName === "UserPromptSubmit" && output) messages.push(output)
      if (result.exitCode !== 0) {
        try {
          if (JSON.parse(result.stdout).decision === "block") throw new Error(result.stderr || "Claude Code hook blocked the operation")
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
    }
    if (messages.length > 0 && typeof event?.sessionID === "string") {
      collector.register(event.sessionID, { id: "hook-context", source: "custom", content: messages.join("\n\n"), priority: "high" })
    }
  }

  return {
    async install() {
      const registrations = []
      if (typeof context?.session?.hook === "function") {
        registrations.push(await context.session.hook("prompt", (event) => dispatch("UserPromptSubmit", event)))
        registrations.push(await context.session.hook("compaction", (event) => dispatch("PreCompact", event)))
      }
      if (typeof context?.tool?.hook === "function") {
        registrations.push(await context.tool.hook("execute.before", (event) => dispatch("PreToolUse", event, event.tool ?? "")))
        registrations.push(await context.tool.hook("execute.after", (event) => dispatch("PostToolUse", event, event.tool ?? "")))
      }
      return () => {
        for (const registration of registrations) void registration?.dispose?.()
      }
    },
    async handleEvent(event) {
      if (event?.type === "session.created") await dispatch("SessionStart", event)
      if (event?.type === "session.idle") await dispatch("Stop", event)
    },
    dispatch,
  }
}
