import fs from "node:fs"
import path from "node:path"

export const DIRECTORY_AGENTS_MARKER = "<rigel-native-directory-agents>"

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function readText(file, limit) {
  try {
    const text = fs.readFileSync(file, "utf8").trim()
    return text ? text.slice(0, limit) : ""
  } catch {
    return ""
  }
}

function requestedReadPath(input, workspace) {
  const args = input?.input ?? input?.args ?? {}
  const raw = args.path ?? args.file ?? args.filename
  if (typeof raw !== "string" || !raw.trim()) return undefined
  return path.resolve(workspace, raw)
}

/**
 * Native V2 replacement for the V1 directory-agents-injector. V2 exposes a
 * post-execution tool hook but does not mutate the completed read output, so
 * the durable V2 boundary is the following provider request of that session.
 */
export function createDirectoryInstructionStore({ directory, maxFiles = 32, maxCharsPerFile = 12_000 } = {}) {
  const workspace = path.resolve(directory ?? process.cwd())
  const sessionFiles = new Map()

  function recordRead(input) {
    if (String(input?.tool ?? "").toLocaleLowerCase() !== "read") return false
    const file = requestedReadPath(input, workspace)
    if (!file || !inside(workspace, file)) return false
    const start = path.dirname(file)
    const found = []
    for (let current = start; inside(workspace, current); current = path.dirname(current)) {
      const agents = path.join(current, "AGENTS.md")
      if (fs.existsSync(agents)) found.push(agents)
      if (current === workspace) break
    }
    if (found.length === 0 || typeof input?.sessionID !== "string") return false
    const known = sessionFiles.get(input.sessionID) ?? new Map()
    // Parent rules are rendered first, then the closest directory rules.
    for (const agents of found.reverse()) {
      if (known.has(agents) || known.size >= maxFiles) continue
      const text = readText(agents, maxCharsPerFile)
      if (text) known.set(agents, text)
    }
    if (known.size === 0) return false
    sessionFiles.set(input.sessionID, known)
    return true
  }

  function guidance(sessionID) {
    const entries = sessionFiles.get(sessionID)
    if (!entries || entries.size === 0) return ""
    return `${DIRECTORY_AGENTS_MARKER}\nDirectory-specific instructions discovered while reading files in this session. Follow them as applicable to the file currently being worked on:\n${[...entries].map(([file, text]) => `<agents-file path=${JSON.stringify(path.relative(workspace, file) || "AGENTS.md")}>\n${text}\n</agents-file>`).join("\n")}\n${DIRECTORY_AGENTS_MARKER}`
  }

  function clear(sessionID) { sessionFiles.delete(sessionID) }
  function clearAll() { sessionFiles.clear() }

  return { recordRead, guidance, clear, clearAll }
}

export function isDirectoryInstructionMessage(message) {
  return message?.role === "system"
    && typeof message.content === "string"
    && message.content.includes(DIRECTORY_AGENTS_MARKER)
}
