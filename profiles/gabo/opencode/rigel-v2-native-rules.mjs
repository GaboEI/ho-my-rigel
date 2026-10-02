import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TRACKED_TOOLS = new Set(["read", "write", "edit", "multiedit"])
const RULE_DIRECTORIES = [
  [".omo", "rules"], [".claude", "rules"], [".cursor", "rules"], [".github", "instructions"], [".sisyphus", "rules"],
]
const GLOBAL_RULE_DIRECTORIES = [".omo/rules", ".opencode/rules", ".claude/rules", ".sisyphus/rules"]
const MAX_RULES_PER_SESSION = 64
const MAX_CHARS_PER_RULE = 12_000

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function requestedFile(input, workspace) {
  const args = input?.input ?? input?.args ?? {}
  const candidate = args.path ?? args.filePath ?? args.file ?? args.filename
  return typeof candidate === "string" && candidate.trim() ? path.resolve(workspace, candidate) : undefined
}

function walkRuleFiles(directory, result = []) {
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walkRuleFiles(file, result)
      else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdc"))) result.push(file)
    }
  } catch { /* an absent or unreadable rule directory is not an error */ }
  return result
}

function parseScalar(value) {
  const raw = value.trim().replace(/^['"]|['"]$/g, "")
  if (raw === "true") return true
  if (raw === "false") return false
  return raw
}

function parseRule(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/) 
  if (!match) return { metadata: {}, body: text.trim() }
  const metadata = {}
  let listKey
  for (const line of match[1].split("\n")) {
    const list = line.match(/^\s*-\s*(.+)$/)
    if (list && listKey) {
      metadata[listKey] ??= []
      metadata[listKey].push(parseScalar(list[1]))
      continue
    }
    const field = line.match(/^\s*(alwaysApply|globs|paths|applyTo)\s*:\s*(.*)$/)
    if (!field) continue
    const [, key, value] = field
    listKey = key
    metadata[key] = value.trim() ? parseScalar(value) : []
  }
  return { metadata, body: text.slice(match[0].length).trim() }
}

function globPattern(pattern) {
  let value = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index]
    const next = pattern[index + 1]
    if (current === "*" && next === "*") {
      while (pattern[index + 1] === "*") index += 1
      if (pattern[index + 1] === "/") {
        value += "(?:.*/)?"
        index += 1
      } else value += ".*"
    } else if (current === "*") value += "[^/]*"
    else if (current === "?") value += "[^/]"
    else value += current.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`^${value}$`)
}

function asPatterns(value) {
  if (typeof value === "string") return [value]
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
}

function matchRule(metadata, relativePath, basename) {
  if (metadata.alwaysApply === true) return "alwaysApply"
  const patterns = [...asPatterns(metadata.globs), ...asPatterns(metadata.paths), ...asPatterns(metadata.applyTo)]
  const negatives = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => globPattern(pattern.slice(1)))
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue
    const matches = globPattern(pattern)
    if (!(matches.test(relativePath) || matches.test(basename))) continue
    if (negatives.some((exclude) => exclude.test(relativePath) || exclude.test(basename))) return undefined
    return `glob: ${pattern}`
  }
}

function append(result, content) {
  if (typeof result?.content === "string") {
    result.content += content
    return true
  }
  if (Array.isArray(result?.content)) {
    result.content.push({ type: "text", text: content })
    return true
  }
  return false
}

function hash(text) { return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) }

/**
 * Native V2 approximation of the V1 rules-engine injection path. It observes
 * the actual file path from a V2 tool event and appends matched rule content
 * to that same tool result, so the next provider request receives it.
 */
export function createNativeRulesInjector({ directory, home = os.homedir() } = {}) {
  const workspace = path.resolve(directory ?? process.cwd())
  const seen = new Map()
  const sessionState = (sessionID) => {
    if (!seen.has(sessionID)) seen.set(sessionID, { paths: new Set(), hashes: new Set() })
    return seen.get(sessionID)
  }
  const candidatesFor = (target) => {
    const root = workspace
    const ancestorDirectories = []
    for (let current = path.dirname(target); inside(root, current); current = path.dirname(current)) {
      ancestorDirectories.unshift(current)
      if (current === root) break
    }
    const files = []
    for (const current of ancestorDirectories) {
      for (const parts of RULE_DIRECTORIES) files.push(...walkRuleFiles(path.join(current, ...parts)))
    }
    const copilot = path.join(root, ".github", "copilot-instructions.md")
    if (fs.existsSync(copilot)) files.push(copilot)
    for (const relative of GLOBAL_RULE_DIRECTORIES) files.push(...walkRuleFiles(path.join(home, relative)))
    return [...new Set(files)]
  }
  return {
    after(event) {
      if (event?.status !== "completed" || !TRACKED_TOOLS.has(String(event.tool ?? "").toLowerCase()) || typeof event.sessionID !== "string") return false
      const target = requestedFile(event, workspace)
      if (!target || !inside(workspace, target)) return false
      const state = sessionState(event.sessionID)
      const relative = path.relative(workspace, target).replaceAll("\\", "/")
      const injected = []
      for (const file of candidatesFor(target)) {
        if (state.paths.has(file) || state.paths.size >= MAX_RULES_PER_SESSION) continue
        let raw
        try { raw = fs.readFileSync(file, "utf8") } catch { continue }
        const { metadata, body } = parseRule(raw)
        const reason = matchRule(metadata, relative, path.basename(target))
        if (!reason || !body) continue
        const contentHash = hash(body)
        if (state.hashes.has(contentHash)) continue
        state.paths.add(file)
        state.hashes.add(contentHash)
        injected.push({ file, body, reason, contentHash })
      }
      if (injected.length === 0) return false
      const output = injected.map((rule) => {
        const pathLabel = path.relative(workspace, rule.file).replaceAll("\\", "/") || path.basename(rule.file)
        const truncated = rule.body.slice(0, MAX_CHARS_PER_RULE)
        const notice = rule.body.length > truncated.length ? `\n\n[Note: Content was truncated. Full: ${pathLabel}]` : ""
        return `\n\n[Rule: ${pathLabel}]\n[Match: ${rule.reason}]\n${truncated}${notice}`
      }).join("")
      return append(event.result, output)
    },
    clear(sessionID) { seen.delete(sessionID) },
    clearAll() { seen.clear() },
  }
}
