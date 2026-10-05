const SCOPE_ORDER = ["project", "user", "opencode-project", "opencode", "builtin", "plugin"]
const ARGUMENT_PATTERN = /\$\{ARGUMENTS\}|\$ARGUMENTS|\$([1-9]\d*)/g

function commandTemplate(command) {
  if (typeof command?.template === "string") return command.template
  if (typeof command?.content === "string") return command.content
  return ""
}

function orderedCommands(commands) {
  const skills = Array.isArray(commands?.skills) ? commands.skills : []
  const scoped = SCOPE_ORDER.flatMap((scope) => Array.isArray(commands?.[scope]) ? commands[scope] : [])
  return [...skills, ...scoped]
}

export function findCommand(name, commands) {
  const normalized = String(name ?? "").toLowerCase()
  return orderedCommands(commands).find((command) => String(command?.name ?? "").toLowerCase() === normalized) ?? null
}

export function renderCommandTemplate(template, args) {
  const positional = String(args ?? "").trim().split(/\s+/).filter(Boolean)
  return String(template ?? "").replace(ARGUMENT_PATTERN, (match, index) => {
    if (match === "${ARGUMENTS}" || match === "$ARGUMENTS") return String(args ?? "")
    return positional[Number(index) - 1] ?? ""
  })
}

export function executeSlashCommand(parsed, commands) {
  const command = findCommand(parsed?.command, commands)
  const template = commandTemplate(command)
  if (!command || !template) return { success: false }
  return { success: true, replacementText: renderCommandTemplate(template, parsed.args) }
}
