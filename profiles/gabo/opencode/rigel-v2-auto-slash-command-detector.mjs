export const AUTO_SLASH_COMMAND_TAG_OPEN = "<auto-slash-command>"
export const AUTO_SLASH_COMMAND_TAG_CLOSE = "</auto-slash-command>"
export const EXCLUDED_COMMANDS = new Set(["ralph-loop", "cancel-ralph", "ulw-loop"])

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g
const SLASH_COMMAND_PATTERN = /^\/([a-zA-Z@][\w.:@/-]*)\s*(.*)/

export function removeCodeBlocks(text) {
  return String(text ?? "").replace(CODE_BLOCK_PATTERN, "")
}

export function parseSlashCommand(text) {
  const trimmed = String(text ?? "").trim()
  if (!trimmed.startsWith("/")) return null
  const match = trimmed.match(SLASH_COMMAND_PATTERN)
  if (!match) return null
  return { command: match[1].toLowerCase(), args: match[2].trim(), raw: match[0] }
}

export function detectSlashCommand(text) {
  const withoutCodeBlocks = removeCodeBlocks(text).trim()
  const parsed = parseSlashCommand(withoutCodeBlocks)
  if (!parsed || EXCLUDED_COMMANDS.has(parsed.command)) return null
  return parsed
}

export function extractPromptText(prompt) {
  return typeof prompt?.text === "string" ? prompt.text : ""
}
