import {
  AUTO_SLASH_COMMAND_TAG_CLOSE,
  AUTO_SLASH_COMMAND_TAG_OPEN,
  detectSlashCommand,
  extractPromptText,
} from "./rigel-v2-auto-slash-command-detector.mjs"
import { executeSlashCommand } from "./rigel-v2-auto-slash-command-executor.mjs"
import { createProcessedCommandStore } from "./rigel-v2-auto-slash-command-store.mjs"

function commandBuckets(commands) {
  const buckets = { skills: [], project: [], user: [], "opencode-project": [], opencode: [], builtin: [], plugin: [] }
  for (const command of commands ?? []) {
    if (!command || typeof command.name !== "string") continue
    const template = typeof command.template === "string" ? command.template : command.content
    if (typeof template !== "string") continue
    const scope = buckets[command.scope] ? command.scope : "plugin"
    buckets[scope].push({ ...command, template })
  }
  return buckets
}

function eventKey(event, parsed) {
  const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
  const messageID = typeof event?.messageID === "string" ? event.messageID : extractPromptText(event?.prompt)
  return `${sessionID}:${messageID}:${parsed.command}`
}

export function createNativeAutoSlashCommandHook({ skills = [], listCommands, now } = {}) {
  const processed = createProcessedCommandStore({ now })

  return {
    async before(event) {
      const text = extractPromptText(event?.prompt)
      if (!text || text.includes(AUTO_SLASH_COMMAND_TAG_OPEN) || text.includes(AUTO_SLASH_COMMAND_TAG_CLOSE)) return
      const parsed = detectSlashCommand(text)
      if (!parsed) return
      const key = eventKey(event, parsed)
      if (processed.has(key)) return

      let hostCommands = []
      if (typeof listCommands === "function") {
        try {
          const listed = await listCommands()
          hostCommands = Array.isArray(listed?.data) ? listed.data : Array.isArray(listed) ? listed : []
        } catch (error) {
          console.error(`[oh-my-rigel] Native V2 slash-command discovery failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const result = executeSlashCommand(parsed, {
        ...commandBuckets(hostCommands),
        skills: Array.isArray(skills) ? skills : [],
      })
      if (!result.success || !result.replacementText) return
      processed.add(key)
      event.prompt.text = `${AUTO_SLASH_COMMAND_TAG_OPEN}\n${result.replacementText}\n${AUTO_SLASH_COMMAND_TAG_CLOSE}`
    },
    clear() {
      processed.clear()
    },
  }
}
