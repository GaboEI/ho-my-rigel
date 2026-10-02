import fs from "node:fs"
import path from "node:path"

export const DIRECTORY_AGENTS_MARKER = "<rigel-native-directory-agents>"
const DIRECTORY_CONTEXT_FILES = ["AGENTS.md", "README.md"]

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
    const directories = []
    for (let current = start; inside(workspace, current); current = path.dirname(current)) {
      directories.unshift(current)
      if (current === workspace) break
    }
    const found = directories.flatMap((current) => DIRECTORY_CONTEXT_FILES
      .map((name) => path.join(current, name))
      .filter((candidate) => fs.existsSync(candidate)))
    if (found.length === 0 || typeof input?.sessionID !== "string") return false
    const known = sessionFiles.get(input.sessionID) ?? new Map()
    // Parent rules are rendered first, then the closest directory rules.
    for (const agents of found) {
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
    const rendered = [...entries].map(([file, text]) => {
      const relative = path.relative(workspace, file) || path.basename(file)
      if (path.basename(file).toLocaleLowerCase() === "readme.md") {
        return `<project-readme path=${JSON.stringify(relative)}>\n${text}\n</project-readme>`
      }
      return `<agents-file path=${JSON.stringify(relative)}>\n${text}\n</agents-file>`
    })
    return `${DIRECTORY_AGENTS_MARKER}\nDirectory-specific rules and documentation discovered while reading files in this session. Follow AGENTS.md rules as applicable; use README.md as project context for the file currently being worked on:\n${rendered.join("\n")}\n${DIRECTORY_AGENTS_MARKER}`
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
