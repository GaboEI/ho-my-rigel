import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

/**
 * Native OpenCode V2 port of the V1 `comment-checker` guard.
 *
 * The real `comment-checker` binary is invoked with the same protocol as
 * `@oh-my-opencode/comment-checker-core` (`check`, JSON HookInput on stdin,
 * exit 0 = clean, exit 2 = comments on stderr). The binary is never downloaded:
 * the native runtime resolves `OMO_COMMENT_CHECKER_BIN`, then the cache slot
 * `$XDG_CACHE_HOME/oh-my-opencode/bin/comment-checker` (only when the sibling
 * `comment-checker.version` marker is the pinned release), then PATH.
 *
 * Bypasses are implemented in this native layer because the pinned 0.8.0
 * binary does NOT honor them (its README lists only BDD comments, linter
 * directives, and shebangs) and V1 has no TypeScript handling either:
 *   - `// @allow` (or `# @allow`, `-- @allow`) exempts the comment on that line
 *     and the comment line immediately after it.
 *   - `// comment-checker-disable-file` (or `#` / `--`) as the first non-blank
 *     line of the NEW content, or of the file already on disk, disables the
 *     whole file.
 * The exempt comments are stripped before the binary runs, so the checker sees
 * clean content and reports nothing.
 */
export const COMMENT_CHECKER_VERSION = "0.8.0"
const BINARY_NAME = process.platform === "win32" ? "comment-checker.exe" : "comment-checker"
const CACHE_DIR_NAME = "oh-my-opencode"
const WRITE_TOOLS = new Set(["write", "edit", "multiedit"])
const DEDUP_WINDOW_MS = 30_000
const MAX_PENDING = 256
const PENDING_TTL_MS = 30 * 60 * 1000
const RUN_TIMEOUT_MS = 30_000

const ALLOW_MARKER = /(^|\s)@allow\b/
const DISABLE_FILE_MARKER = /(^|[\s;])(?:\/\/|#|--)\s*comment-checker-disable-file\b/
const COMMENT_LINE = /^\s*(\/\/|\/\*|#|--|<!--)/

function cacheBinaryPath(env, homedir) {
  const base = env.XDG_CACHE_HOME || path.join(homedir, ".cache")
  return path.join(base, CACHE_DIR_NAME, "bin", BINARY_NAME)
}

function fromPathScan(pathValue, name, existsSync) {
  for (const dir of String(pathValue).split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function resolveCommentCheckerBinary(deps = {}) {
  const env = deps.env ?? process.env
  const homedir = typeof deps.homedir === "function" ? deps.homedir() : deps.homedir ?? os.homedir()
  const existsSync = deps.existsSync ?? fs.existsSync
  const readFileSync = deps.readFileSync ?? fs.readFileSync
  const override = env.OMO_COMMENT_CHECKER_BIN
  if (typeof override === "string" && override && existsSync(override)) return override
  const cached = cacheBinaryPath(env, homedir)
  if (existsSync(cached)) {
    let current = false
    try { current = readFileSync(`${cached}.version`, "utf8").trim() === COMMENT_CHECKER_VERSION } catch { current = false }
    if (current) return cached
  }
  return env.PATH ? fromPathScan(env.PATH, BINARY_NAME, existsSync) : undefined
}

export function resultText(result) {
  if (typeof result?.content === "string") return result.content
  if (Array.isArray(result?.content)) return result.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
  return ""
}

function appendResult(result, text) {
  if (typeof result?.content === "string") { result.content += text; return true }
  if (Array.isArray(result?.content)) { result.content.push({ type: "text", text }); return true }
  return false
}

function isToolFailure(text) {
  const lower = String(text ?? "").toLowerCase()
  return lower.includes("error:") || lower.includes("failed to") || lower.includes("could not") || lower.startsWith("error")
}

function hasCommentSyntax(text) {
  if (!text) return false
  return /^\s*(\/\/|\/\*|#|--|<!--|:\s*)[\s\S]*$/m.test(text) || /<!--[\s\S]*-->/.test(text)
}

function newTextsFor(call) {
  if (call.tool === "write") return call.content ? [call.content] : []
  if (call.tool === "multiedit") return (call.edits ?? []).map((edit) => edit?.new_string).filter((text) => typeof text === "string")
  return typeof call.newString === "string" ? [call.newString] : []
}

function hasNewCommentsOnly(oldText, newText) {
  if (!hasCommentSyntax(newText)) return false
  if (!hasCommentSyntax(oldText)) return true
  const oldLines = new Set(String(oldText ?? "").split("\n").map((line) => line.trim()))
  return String(newText ?? "").split("\n").some((line) => {
    const trimmed = line.trim()
    return trimmed && hasCommentSyntax(trimmed) && !oldLines.has(trimmed)
  })
}

export function stripAllowedComments(text) {
  const lines = String(text ?? "").split("\n")
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (ALLOW_MARKER.test(line)) continue
    const previous = index > 0 ? lines[index - 1] : ""
    if (ALLOW_MARKER.test(previous) && COMMENT_LINE.test(line)) continue
    kept.push(line)
  }
  return kept.join("\n")
}

function leadingMarker(text) {
  return String(text ?? "").split("\n").find((line) => line.trim() !== "") ?? ""
}

/** True when the file is disabled by a marker in the new content or on disk. */
export function isFileDisabled(call, deps) {
  if (newTextsFor(call).some((text) => DISABLE_FILE_MARKER.test(leadingMarker(text)))) return true
  if (typeof call.filePath !== "string" || !call.filePath || !deps.existsSync(call.filePath)) return false
  try {
    return DISABLE_FILE_MARKER.test(leadingMarker(deps.readFileSync(call.filePath, "utf8")))
  } catch {
    return false
  }
}

function capitalize(value) {
  const text = String(value ?? "")
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

export async function runCommentChecker({ binaryPath, hookInput, customPrompt, spawn: spawnFn, timeoutMs = RUN_TIMEOUT_MS }) {
  if (!binaryPath) return { hasComments: false, message: "" }
  const args = [binaryPath, "check"]
  if (customPrompt !== undefined) args.push("--prompt", customPrompt)
  const doSpawn = spawnFn ?? ((argv, opts) => spawn(argv[0], argv.slice(1), opts))
  let child
  try { child = doSpawn(args, { stdio: ["pipe", "pipe", "pipe"] }) } catch { return { hasComments: false, message: "" } }
  return await new Promise((resolve) => {
    let settled = false
    const done = (result) => { if (!settled) { settled = true; resolve(result) } }
    let stderr = ""
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* already gone */ } done({ hasComments: false, message: "" }) }, timeoutMs)
    if (typeof child.stdout?.resume === "function") child.stdout.resume()
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    child.on("error", () => { clearTimeout(timer); done({ hasComments: false, message: "" }) })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 2 && stderr) return done({ hasComments: true, message: stderr })
      return done({ hasComments: false, message: "" })
    })
    try { child.stdin.write(JSON.stringify(hookInput)); child.stdin.end() } catch { /* the close handler still settles */ }
  })
}

function pathArgument(event) {
  const args = event?.input ?? event?.args ?? {}
  const value = args.path ?? args.filePath ?? args.file_path
  return typeof value === "string" && value ? value : undefined
}

export function createNativeCommentChecker(options = {}) {
  const deps = {
    env: options.env ?? process.env,
    homedir: options.homedir ?? os.homedir(),
    existsSync: options.existsSync ?? fs.existsSync,
    readFileSync: options.readFileSync ?? fs.readFileSync,
    spawn: options.spawn,
    now: options.now ?? (() => Date.now()),
    customPrompt: options.customPrompt,
  }
  const runner = options.runner ?? ((binaryPath, hookInput, customPrompt) => runCommentChecker({ binaryPath, hookInput, customPrompt, spawn: deps.spawn }))
  const pending = new Map()
  const lastWarning = new Map()

  const eventKey = (event) => {
    if (typeof event?.id === "string" && event.id) return event.id
    if (typeof event?.sessionID !== "string") return undefined
    return `${event.sessionID}|${pathArgument(event) ?? ""}`
  }
  const prune = () => {
    const now = deps.now()
    for (const [key, call] of pending) if (now - call.timestamp > PENDING_TTL_MS) pending.delete(key)
  }
  const synthesize = (event, tool) => {
    const args = event?.input ?? event?.args ?? {}
    const filePath = pathArgument(event)
    if (!filePath) return undefined
    return {
      filePath,
      content: args.content,
      oldString: args.oldString ?? args.old_string,
      newString: args.newString ?? args.new_string,
      edits: args.edits,
      tool,
      sessionID: event?.sessionID,
    }
  }

  return {
    before(event) {
      const tool = String(event?.tool ?? "").toLowerCase()
      if (!WRITE_TOOLS.has(tool)) return
      const call = synthesize(event, tool)
      const key = eventKey(event)
      if (!call || !key) return
      prune()
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value)
      pending.set(key, { ...call, timestamp: deps.now() })
    },
    async after(event) {
      const tool = String(event?.tool ?? "").toLowerCase()
      if (!WRITE_TOOLS.has(tool)) return false
      if (isToolFailure(resultText(event?.result))) return false
      const key = eventKey(event)
      let call = key ? pending.get(key) : undefined
      if (call && key) pending.delete(key)
      if (!call) call = synthesize(event, tool)
      if (!call) return false
      if (isFileDisabled(call, deps)) return false

      const newTexts = newTextsFor(call)
      const oldTexts = call.tool === "multiedit"
        ? (call.edits ?? []).map((edit) => edit?.old_string ?? "")
        : [call.oldString]
      const effective = newTexts.map((text, index) => stripAllowedComments(text))
      const hasNew = effective.some((text, index) => hasNewCommentsOnly(oldTexts[index], text))
      if (!hasNew) return false

      const sessionID = call.sessionID ?? event?.sessionID
      if (typeof sessionID === "string" && deps.now() - (lastWarning.get(sessionID) ?? 0) < DEDUP_WINDOW_MS) return false
      const binaryPath = resolveCommentCheckerBinary({ env: deps.env, homedir: deps.homedir, existsSync: deps.existsSync, readFileSync: deps.readFileSync })
      if (!binaryPath) return false
      if (typeof sessionID === "string") lastWarning.set(sessionID, deps.now())

      const toolInput = { file_path: call.filePath, old_string: call.oldString, new_string: call.newString, edits: call.edits }
      if (call.tool === "write") toolInput.content = effective[0]
      else if (call.tool === "edit") toolInput.new_string = effective[0]
      else toolInput.edits = (call.edits ?? []).map((edit, index) => ({ old_string: edit?.old_string, new_string: effective[index] ?? edit?.new_string }))

      const hookInput = {
        session_id: typeof sessionID === "string" ? sessionID : "",
        tool_name: capitalize(call.tool),
        transcript_path: "",
        cwd: process.cwd(),
        hook_event_name: "PostToolUse",
        tool_input: toolInput,
      }
      let result
      try { result = await runner(binaryPath, hookInput, deps.customPrompt) } catch { return false }
      if (result && result.hasComments && result.message) return appendResult(event?.result, `\n\n${result.message}`)
      return false
    },
    clear(sessionID) {
      lastWarning.delete(sessionID)
      for (const [key, call] of pending) if (call.sessionID === sessionID) pending.delete(key)
    },
    clearAll() { pending.clear(); lastWarning.clear() },
  }
}
