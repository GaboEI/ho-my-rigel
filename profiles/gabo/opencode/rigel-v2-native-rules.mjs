import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Native V2 port of the V1 rules-engine discovery + matching semantics. The V1
// implementation is TypeScript and depends on picomatch plus shared workspace
// packages; the flat V2 runtime cannot import either, so discovery, the
// line-based frontmatter parser, the picomatch-subset matcher, the token-limit
// truncator, and the dedup state all live here using Node builtins only.

export const PROJECT_MARKERS = [".git", "pyproject.toml", "package.json", "Cargo.toml", "go.mod", ".venv"]
export const PROJECT_RULE_SUBDIRS = [
  [".omo", "rules"],
  [".claude", "rules"],
  [".cursor", "rules"],
  [".github", "instructions"],
  [".sisyphus", "rules"],
]
export const PROJECT_RULE_FILES = [".github/copilot-instructions.md"]
export const OPENCODE_USER_RULE_DIRS = [".omo/rules", ".opencode/rules", ".sisyphus/rules"]
export const USER_RULE_DIR = ".claude/rules"
export const RULE_EXTENSIONS = [".md", ".mdc"]
export const GITHUB_INSTRUCTIONS_PATTERN = /\.instructions\.md$/
export const GLOBAL_DISTANCE = 9999
export const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage"])
export const SOURCE_PRIORITY = new Map([
  [".omo/rules", 0],
  [".claude/rules", 1],
  [".cursor/rules", 2],
  [".github/instructions", 3],
  [".github/copilot-instructions.md", 4],
  [".sisyphus/rules", 5],
  ["~/.omo/rules", 100],
  ["~/.opencode/rules", 101],
  ["~/.claude/rules", 102],
  ["~/.sisyphus/rules", 103],
])
export const SINGLE_FILE_MATCH_REASON = "copilot-instructions (always apply)"
export const ALWAYS_APPLY_MATCH_REASON = "alwaysApply"

const TRACKED_TOOLS = new Set(["read", "write", "edit", "multiedit"])
const CHARS_PER_TOKEN_ESTIMATE = 4
export const DEFAULT_TARGET_MAX_TOKENS = 50_000
export const PRESERVE_HEADER_LINES = 3
const CONTENT_HASH_LENGTH = 16
const TRUNCATION_NOTICE_PREFIX = "\n\n[Note: Content was truncated to save context window space. For full context, please read the file directly: "

function toPosix(value) {
  return value.replaceAll("\\", "/")
}

function isPathWithinRoot(candidate, root) {
  const relativePath = path.relative(root, candidate)
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}

function safeRealpathSync(targetPath) {
  try {
    return fs.realpathSync.native(targetPath)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const parentPath = path.dirname(targetPath)
    if (parentPath === targetPath) return targetPath
    return path.join(safeRealpathSync(parentPath), path.basename(targetPath))
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parser (line-based, mirrors rules-engine parser-yaml semantics)
// ---------------------------------------------------------------------------

function stripComment(line) {
  let quote = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote !== null && character === "\\") {
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      if (quote === null) quote = character
      else if (quote === character) quote = null
      continue
    }
    if (quote === null && character === "#") return line.slice(0, index)
  }
  return line
}

function parseStringValue(value) {
  if (value.length === 0) return ""
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === "string") return parsed
    } catch {
      // Not a JSON string literal; fall through to a bare quote strip.
    }
    return value.replace(/^"+|"+$/g, "")
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1)
  return value
}

function splitCommaSeparated(value) {
  const values = []
  let current = ""
  let quote = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (quote !== null && character === "\\") {
      current += character
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      if (quote === null) quote = character
      else if (quote === character) quote = null
      current += character
      continue
    }
    if (quote === null && character === ",") {
      values.push(current.trim())
      current = ""
      continue
    }
    current += character
  }
  values.push(current.trim())
  return values.filter(Boolean)
}

function parseInlineArray(value) {
  const closingBracketIndex = value.lastIndexOf("]")
  if (closingBracketIndex === -1) return null
  const content = value.slice(1, closingBracketIndex).trim()
  if (content.length === 0) return []
  return splitCommaSeparated(content).map(parseStringValue).filter(Boolean)
}

function parseGlobValue(rawValue, lines, lineIndex) {
  if (rawValue.startsWith("[")) {
    const inline = parseInlineArray(rawValue)
    if (inline !== null) return { values: inline, consumed: 1 }
  }
  if (rawValue.length === 0) {
    const values = []
    let consumed = 1
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      const line = stripComment(lines[index])
      if (line.trim().length === 0) {
        consumed += 1
        continue
      }
      const item = line.match(/^\s+-\s*(.*)$/)
      if (item === null) break
      values.push(parseStringValue(item[1].trim()))
      consumed += 1
    }
    return { values: values.filter(Boolean), consumed }
  }
  const value = parseStringValue(rawValue)
  if (!/^["']/.test(rawValue) && value.includes(",")) {
    return { values: value.split(",").map((item) => item.trim()).filter(Boolean), consumed: 1 }
  }
  return { values: [value].filter(Boolean), consumed: 1 }
}

export function parseRuleFrontmatter(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if ((lines[0] ?? "").trim() !== "---") return { metadata: {}, body: normalized.trim() }
  let closingIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      closingIndex = index
      break
    }
  }
  if (closingIndex === -1) return { metadata: {}, body: normalized.trim() }

  const metadata = {}
  const globs = []
  const seenGlobs = new Set()
  let lineIndex = 1
  while (lineIndex < closingIndex) {
    const line = stripComment(lines[lineIndex]).trim()
    if (line.length === 0) {
      lineIndex += 1
      continue
    }
    const colonIndex = line.indexOf(":")
    if (colonIndex === -1) {
      lineIndex += 1
      continue
    }
    const key = line.slice(0, colonIndex).trim()
    const rawValue = line.slice(colonIndex + 1).trim()
    if (key === "alwaysApply") {
      if (rawValue === "true") metadata.alwaysApply = true
      lineIndex += 1
      continue
    }
    if (key === "description") {
      metadata.description = parseStringValue(rawValue)
      lineIndex += 1
      continue
    }
    if (key === "globs" || key === "paths" || key === "applyTo") {
      const parsed = parseGlobValue(rawValue, lines, lineIndex)
      for (const glob of parsed.values) {
        if (seenGlobs.has(glob)) continue
        seenGlobs.add(glob)
        globs.push(glob)
      }
      lineIndex += parsed.consumed
      continue
    }
    lineIndex += 1
  }

  if (globs.length === 1) metadata.globs = globs[0]
  else if (globs.length > 1) metadata.globs = globs
  return { metadata, body: lines.slice(closingIndex + 1).join("\n").trim() }
}

// ---------------------------------------------------------------------------
// Glob matcher (picomatch subset: {dot:true, bash:true} for rule patterns)
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function expandBraces(pattern) {
  const start = pattern.indexOf("{")
  if (start === -1) return [pattern]
  let depth = 0
  let end = -1
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1
    else if (pattern[index] === "}") {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) return [pattern]
  const body = pattern.slice(start + 1, end)
  const parts = []
  let nested = 0
  let current = ""
  for (const character of body) {
    if (character === "{") nested += 1
    if (character === "}") nested -= 1
    if (character === "," && nested === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += character
  }
  parts.push(current)
  if (parts.length < 2) return [pattern]
  const prefix = pattern.slice(0, start)
  const suffix = pattern.slice(end + 1)
  const expanded = []
  for (const part of parts) for (const value of expandBraces(prefix + part + suffix)) expanded.push(value)
  return expanded
}

// In bash mode picomatch maps a single `*` to a non-greedy match that crosses
// path separators, and `**` to the globstar with an implicit `(?:.*/)?` when it
// is a full path segment. The two `**` forms below reproduce that behavior.
function translateGlob(pattern) {
  let output = ""
  let index = 0
  while (index < pattern.length) {
    if (pattern.startsWith("/**", index) && (index + 3 === pattern.length || pattern[index + 3] === "/")) {
      if (index + 3 === pattern.length) {
        output += "(?:/.*)?"
        index += 3
        continue
      }
      output += "/(?:.*/)?"
      index += 4
      continue
    }
    if (pattern.startsWith("**/", index)) {
      output += "(?:.*/)?"
      index += 3
      continue
    }
    if (pattern.startsWith("**", index)) {
      output += ".*"
      index += 2
      continue
    }
    const character = pattern[index]
    if (character === "*") {
      output += ".*"
      index += 1
      continue
    }
    if (character === "?") {
      output += "[^/]"
      index += 1
      continue
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1)
      if (closing === -1) {
        output += "\\["
        index += 1
        continue
      }
      let charClass = pattern.slice(index + 1, closing)
      let negated = false
      if (charClass.startsWith("!") || charClass.startsWith("^")) {
        negated = true
        charClass = charClass.slice(1)
      }
      output += `[${negated ? "^" : ""}${charClass}]`
      index = closing + 1
      continue
    }
    if (character === "/") {
      output += "/"
      index += 1
      continue
    }
    output += escapeRegExp(character)
    index += 1
  }
  return new RegExp(`^${output}$`)
}

const baseMatcherCache = new Map()

function compileBaseMatcher(pattern) {
  const cached = baseMatcherCache.get(pattern)
  if (cached) return cached
  const regexes = expandBraces(pattern).map(translateGlob)
  const matcher = (candidate) => candidate !== "" && regexes.some((regex) => regex.test(candidate))
  baseMatcherCache.set(pattern, matcher)
  return matcher
}

export function matchesGlob(pattern, candidate) {
  if (typeof pattern !== "string" || typeof candidate !== "string") return false
  if (pattern.startsWith("!")) {
    const inner = compileBaseMatcher(pattern.slice(1))
    return candidate !== "" && !inner(candidate)
  }
  return compileBaseMatcher(pattern)(candidate)
}

function normalizePatternList(patterns) {
  if (patterns === undefined || patterns === null) return []
  if (typeof patterns === "string") return [patterns]
  return Array.isArray(patterns) ? patterns.filter((item) => typeof item === "string") : []
}

function normalizeGlobs(metadata) {
  const patterns = [
    ...normalizePatternList(metadata.globs),
    ...normalizePatternList(metadata.paths),
    ...normalizePatternList(metadata.applyTo),
  ].map(toPosix)
  return [...new Set(patterns)]
}

export function matchRuleReason(metadata, currentFile, projectRoot) {
  if (metadata.alwaysApply === true) return ALWAYS_APPLY_MATCH_REASON
  const patterns = normalizeGlobs(metadata)
  if (patterns.length === 0) return undefined
  const pathBases = [
    toPosix(projectRoot ? path.relative(projectRoot, currentFile) : currentFile),
    toPosix(path.basename(currentFile)),
  ]
  const negativeMatchers = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1))
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue
    if (!pathBases.some((pathBase) => matchesGlob(pattern, pathBase))) continue
    if (pathBases.some((pathBase) => negativeMatchers.some((exclude) => matchesGlob(exclude, pathBase)))) return undefined
    return `glob: ${pattern}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Token-limit truncator (dynamic target without a usage source)
// ---------------------------------------------------------------------------

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

export function truncateToTokenLimit(output, maxTokens, preserveHeaderLines = PRESERVE_HEADER_LINES) {
  if (typeof output !== "string") return { result: String(output ?? ""), truncated: false }
  if (estimateTokens(output) <= maxTokens) return { result: output, truncated: false }
  const lines = output.split("\n")
  if (lines.length <= preserveHeaderLines) {
    const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE
    return { result: `${output.slice(0, maxChars)}\n\n[Output truncated due to context window limit]`, truncated: true }
  }
  const headerLines = lines.slice(0, preserveHeaderLines)
  const contentLines = lines.slice(preserveHeaderLines)
  const headerText = headerLines.join("\n")
  const availableTokens = maxTokens - estimateTokens(headerText) - 50
  if (availableTokens <= 0) {
    return { result: `${headerText}\n\n[Content truncated due to context window limit]`, truncated: true, removedCount: contentLines.length }
  }
  const resultLines = []
  let tokenCount = 0
  for (const line of contentLines) {
    const lineTokens = estimateTokens(`${line}\n`)
    if (tokenCount + lineTokens > availableTokens) break
    resultLines.push(line)
    tokenCount += lineTokens
  }
  const removedCount = contentLines.length - resultLines.length
  return {
    result: `${[...headerLines, ...resultLines].join("\n")}\n\n[${removedCount} more lines truncated due to context window limit]`,
    truncated: true,
    removedCount,
  }
}

// ---------------------------------------------------------------------------
// Discovery (project root, ancestor walk with distance, user dirs, scanner)
// ---------------------------------------------------------------------------

export function findProjectRoot(startPath) {
  if (typeof startPath !== "string" || startPath.length === 0) return null
  let startDir
  try {
    startDir = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath)
  } catch {
    startDir = path.dirname(startPath)
  }
  let current = startDir
  while (true) {
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function isGitHubInstructionsDir(directory) {
  const normalized = toPosix(directory)
  return normalized.includes(".github/instructions") || normalized.endsWith(".github/instructions")
}

function isRuleFile(fileName, directory) {
  if (isGitHubInstructionsDir(directory)) return GITHUB_INSTRUCTIONS_PATTERN.test(fileName)
  return RULE_EXTENSIONS.some((extension) => fileName.endsWith(extension))
}

function scanRuleFiles(directory, results, visited, boundaryRoot) {
  if (!fs.existsSync(directory)) return
  const realDir = safeRealpathSync(directory)
  const effectiveBoundary = boundaryRoot === undefined ? realDir : safeRealpathSync(boundaryRoot)
  if (!isPathWithinRoot(realDir, effectiveBoundary)) return
  if (visited.has(realDir)) return
  visited.add(realDir)
  let entries = []
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true, encoding: "utf8" }).sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) scanRuleFiles(fullPath, results, visited, effectiveBoundary)
      continue
    }
    if (!entry.isFile() || !isRuleFile(entry.name, directory)) continue
    const realPath = safeRealpathSync(fullPath)
    if (!isPathWithinRoot(realPath, effectiveBoundary)) continue
    results.push({ path: fullPath, realPath, relativePath: entry.name })
  }
}

function collectDirectoryEntries(directory, boundaryRoot) {
  const results = []
  scanRuleFiles(directory, results, new Set(), boundaryRoot)
  return results
}

function validFileRealPath(filePath, boundaryRealPath) {
  if (!fs.existsSync(filePath)) return null
  try {
    if (!fs.statSync(filePath).isFile()) return null
    const realPath = safeRealpathSync(filePath)
    if (boundaryRealPath !== undefined && !isPathWithinRoot(realPath, boundaryRealPath)) return null
    return realPath
  } catch {
    return null
  }
}

function addProjectRuleCandidates(effectiveRoot, startDir, candidates, seenRealPaths, boundaryRealPath) {
  let currentDir = startDir
  let distance = 0
  while (true) {
    for (const [parent, subdir] of PROJECT_RULE_SUBDIRS) {
      const source = `${parent}/${subdir}`
      const ruleDir = path.join(currentDir, parent, subdir)
      for (const entry of collectDirectoryEntries(ruleDir, boundaryRealPath)) {
        if (seenRealPaths.has(entry.realPath)) continue
        seenRealPaths.add(entry.realPath)
        candidates.push({
          path: entry.path,
          realPath: entry.realPath,
          source,
          isGlobal: false,
          distance,
          relativePath: toPosix(path.relative(effectiveRoot, entry.path)),
        })
      }
    }
    if (currentDir === effectiveRoot) break
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir || !isPathWithinRoot(parentDir, effectiveRoot)) break
    currentDir = parentDir
    distance += 1
  }
}

function addProjectSingleFileCandidates(effectiveRoot, candidates, seenRealPaths, boundaryRealPath) {
  for (const ruleFile of PROJECT_RULE_FILES) {
    const filePath = path.join(effectiveRoot, ruleFile)
    const realPath = validFileRealPath(filePath, boundaryRealPath)
    if (realPath === null || seenRealPaths.has(realPath)) continue
    seenRealPaths.add(realPath)
    candidates.push({
      path: filePath,
      realPath,
      source: ruleFile,
      isGlobal: false,
      distance: 0,
      isSingleFile: true,
      relativePath: ruleFile,
    })
  }
}

function addUserRuleCandidates(homeDir, skipClaudeUserRules, candidates, seenRealPaths) {
  const userRuleDirs = OPENCODE_USER_RULE_DIRS.map((directory) => [path.join(homeDir, directory), `~/${directory}`])
  if (!skipClaudeUserRules) userRuleDirs.push([path.join(homeDir, USER_RULE_DIR), "~/.claude/rules"])
  for (const [directory, source] of userRuleDirs) {
    for (const entry of collectDirectoryEntries(directory)) {
      if (seenRealPaths.has(entry.realPath)) continue
      seenRealPaths.add(entry.realPath)
      candidates.push({
        path: entry.path,
        realPath: entry.realPath,
        source,
        isGlobal: true,
        distance: GLOBAL_DISTANCE,
        relativePath: toPosix(path.relative(homeDir, entry.path)),
      })
    }
  }
}

function compareCandidates(left, right) {
  return (
    Number(left.isGlobal) - Number(right.isGlobal) ||
    left.distance - right.distance ||
    (SOURCE_PRIORITY.get(left.source) ?? Number.POSITIVE_INFINITY) - (SOURCE_PRIORITY.get(right.source) ?? Number.POSITIVE_INFINITY) ||
    (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0) ||
    (left.realPath < right.realPath ? -1 : left.realPath > right.realPath ? 1 : 0)
  )
}

function sortRuleCandidates(candidates) {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => compareCandidates(left.candidate, right.candidate) || left.index - right.index)
    .map(({ candidate }) => candidate)
}

// ---------------------------------------------------------------------------
// Transcript hydration (V1 rules-injector crash-safety second dedup layer)
// ---------------------------------------------------------------------------

const HYDRATION_MARKER = /\[Rule: ([^\]\n]+)\]\n\[Match: [^\]\n]+\]/g
const HYDRATION_MAX_MESSAGES = 200
const HYDRATION_MAX_CHARS = 1_000_000

function extractMessageText(message) {
  if (!message || typeof message !== "object") return ""
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && typeof part.text === "string") return part.text
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return typeof message.text === "string" ? message.text : ""
}

function collectHydratedRelativePaths(messages) {
  const paths = new Set()
  if (!Array.isArray(messages)) return paths
  let seenMessages = 0
  let seenChars = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (seenMessages >= HYDRATION_MAX_MESSAGES || seenChars >= HYDRATION_MAX_CHARS) break
    const text = extractMessageText(messages[index])
    if (!text) continue
    seenMessages += 1
    seenChars += text.length
    HYDRATION_MARKER.lastIndex = 0
    let match
    while ((match = HYDRATION_MARKER.exec(text)) !== null) {
      paths.add(match[1].replaceAll("\\", "/"))
    }
  }
  return paths
}

// ---------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------

function requestedFile(event, workspace) {
  const args = event?.input ?? event?.args ?? {}
  const candidate = args.path ?? args.filePath ?? args.file ?? args.filename
  if (typeof candidate === "string" && candidate.trim()) return path.isAbsolute(candidate) ? candidate : path.resolve(workspace, candidate)
  const metadataPath = event?.result?.metadata?.filePath
  if (typeof metadataPath === "string" && metadataPath.trim()) return path.isAbsolute(metadataPath) ? metadataPath : path.resolve(workspace, metadataPath)
  return undefined
}

function appendToResult(result, content) {
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

function contentHash(body) {
  return crypto.createHash("sha256").update(body).digest("hex").slice(0, CONTENT_HASH_LENGTH)
}

/**
 * Native V2 port of the V1 rules-engine injection path. It observes the file a
 * tracked tool touched, discovers project and user rules with the same
 * project-root walk, distance ordering, frontmatter parsing, and picomatch
 * subset matching the V1 engine uses, then appends each still-unseen rule to
 * the same tool result so the next provider request receives it.
 */
export function createNativeRulesInjector({ directory, home = os.homedir(), skipClaudeUserRules = false, getSessionMessages } = {}) {
  const workspace = path.resolve(directory ?? process.cwd())
  const userHome = path.resolve(home)
  const sessions = new Map()

  const sessionState = (sessionID) => {
    if (!sessions.has(sessionID)) sessions.set(sessionID, { realPaths: new Set(), contentHashes: new Set(), hydrated: undefined, hydrating: undefined })
    return sessions.get(sessionID)
  }

  // Lazy, single-flight hydration: at most one in-flight read of the session
  // transcript per session; a failed read degrades to an empty set.
  const ensureHydrated = (sessionID) => {
    const state = sessionState(sessionID)
    if (state.hydrated) return Promise.resolve(state.hydrated)
    if (state.hydrating) return state.hydrating
    state.hydrating = (async () => {
      let messages
      try {
        messages = typeof getSessionMessages === "function" ? await getSessionMessages(sessionID) : undefined
      } catch {
        messages = undefined
      }
      const list = Array.isArray(messages) ? messages : (Array.isArray(messages?.data) ? messages.data : [])
      state.hydrated = collectHydratedRelativePaths(list)
      state.hydrating = undefined
      return state.hydrated
    })()
    return state.hydrating
  }

  const collectCandidates = (target) => {
    const projectRoot = findProjectRoot(target)
    const startDir = path.dirname(target)
    const effectiveRoot = projectRoot ?? (isPathWithinRoot(startDir, workspace) ? workspace : startDir)
    const boundaryRealPath = safeRealpathSync(effectiveRoot)
    const candidates = []
    const seenRealPaths = new Set()
    addProjectRuleCandidates(effectiveRoot, startDir, candidates, seenRealPaths, boundaryRealPath)
    addProjectSingleFileCandidates(effectiveRoot, candidates, seenRealPaths, boundaryRealPath)
    addUserRuleCandidates(userHome, skipClaudeUserRules, candidates, seenRealPaths)
    return { projectRoot, effectiveRoot, candidates: sortRuleCandidates(candidates) }
  }

  return {
    async after(event) {
      if (event?.status !== "completed") return false
      if (!TRACKED_TOOLS.has(String(event.tool ?? "").toLowerCase())) return false
      if (typeof event.sessionID !== "string" || event.sessionID.length === 0) return false
      const target = requestedFile(event, workspace)
      if (!target) return false

      const { projectRoot, effectiveRoot, candidates } = collectCandidates(target)
      const matchRoot = projectRoot ?? effectiveRoot
      const state = sessionState(event.sessionID)
      const hydrated = await ensureHydrated(event.sessionID)
      const injected = []

      for (const candidate of candidates) {
        if (state.realPaths.has(candidate.realPath)) continue
        let raw
        try {
          raw = fs.readFileSync(candidate.path, "utf8")
        } catch {
          continue
        }
        const { metadata, body } = parseRuleFrontmatter(raw)
        const reason = candidate.isSingleFile ? SINGLE_FILE_MATCH_REASON : matchRuleReason(metadata, target, matchRoot)
        if (!reason) continue
        const hash = contentHash(body)
        if (state.contentHashes.has(hash)) continue
        state.realPaths.add(candidate.realPath)
        state.contentHashes.add(hash)
        // Transcript hydration: a rule whose marker is already present in the
        // conversation must not be emitted again even when the in-memory cache
        // was lost. Mark it seen and skip the append.
        if (hydrated.has(candidate.relativePath)) continue
        injected.push({ relativePath: candidate.relativePath, body, reason, distance: candidate.distance })
      }

      if (injected.length === 0) return false
      injected.sort((left, right) => left.distance - right.distance)

      const output = injected
        .map((rule) => {
          const { result, truncated } = truncateToTokenLimit(rule.body, DEFAULT_TARGET_MAX_TOKENS, PRESERVE_HEADER_LINES)
          const notice = truncated ? `${TRUNCATION_NOTICE_PREFIX}${rule.relativePath}]` : ""
          return `\n\n[Rule: ${rule.relativePath}]\n[Match: ${rule.reason}]\n${result}${notice}`
        })
        .join("")
      return appendToResult(event.result, output)
    },
    clear(sessionID) {
      sessions.delete(sessionID)
    },
    clearAll() {
      sessions.clear()
    },
  }
}
