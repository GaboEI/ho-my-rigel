import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const EVENT_NAMES = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "SessionStart", "Stop"]

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === "ENOENT") return undefined
    throw error
  }
}

function normalizeHooks(raw) {
  const result = {}
  for (const event of EVENT_NAMES) {
    if (!Array.isArray(raw?.[event])) continue
    result[event] = raw[event]
      .filter((matcher) => matcher && Array.isArray(matcher.hooks))
      .map((matcher) => ({ matcher: matcher.matcher ?? matcher.pattern ?? "*", hooks: matcher.hooks }))
  }
  return result
}

export async function loadNativeClaudeCodeHooksConfig({ directory, home = os.homedir() } = {}) {
  const files = [
    path.join(home, ".claude", "settings.json"),
    path.join(directory ?? process.cwd(), ".claude", "settings.json"),
    path.join(directory ?? process.cwd(), ".claude", "settings.local.json"),
  ]
  const merged = {}
  for (const file of [...new Set(files)]) {
    const settings = await readJson(file)
    const hooks = normalizeHooks(settings?.hooks)
    for (const [event, matchers] of Object.entries(hooks)) merged[event] = [...(merged[event] ?? []), ...matchers]
  }
  return merged
}

export async function loadNativeClaudeCodePluginConfig({ directory, home = os.homedir() } = {}) {
  const files = [
    path.join(home, ".config", "opencode", "opencode-cc-plugin.json"),
    path.join(directory ?? process.cwd(), ".opencode", "opencode-cc-plugin.json"),
  ]
  const disabledHooks = {}
  for (const file of files) {
    const config = await readJson(file)
    for (const [event, patterns] of Object.entries(config?.disabledHooks ?? {})) {
      if (Array.isArray(patterns)) disabledHooks[event] = [...(disabledHooks[event] ?? []), ...patterns]
    }
  }
  return { disabledHooks }
}

export function matchingNativeClaudeHooks(config, event, subject = "") {
  return (config?.[event] ?? []).flatMap((matcher) => {
    try {
      return (matcher.matcher === "*" || new RegExp(matcher.matcher).test(subject)) ? matcher.hooks : []
    } catch {
      return []
    }
  })
}

export function nativeClaudeHookDisabled(pluginConfig, event, hook) {
  const name = hook?.type === "http" ? hook.url : hook?.command
  if (typeof name !== "string") return true
  return (pluginConfig?.disabledHooks?.[event] ?? []).some((pattern) => {
    try {
      return new RegExp(pattern).test(name)
    } catch {
      return false
    }
  })
}
