// Native OpenCode V2 search primitives for the `glob`/`grep` tools.
//
// Faithful port of the V1 owner contract in
// `packages/omo-opencode/src/tools/glob/cli.ts`, `.../grep/cli.ts` and their
// `constants.ts`: the rg flag sets, the Unix `find` and Windows PowerShell glob
// fallbacks, the classic GNU grep fallback, the process-output collection, the
// parsers, and the ripgrep concurrency cap. Every flag, limit and parser mirrors
// V1 so the same observable call reproduces V1 output, including on a host
// without ripgrep. Platform and process primitives are injectable for hermetic
// tests.
import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import path from "node:path"
import { rgSemaphore } from "./glob-grep-concurrency.mjs"

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_LIMIT = 100
export const DEFAULT_MAX_DEPTH = 20
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024
export const DEFAULT_RG_THREADS = 4
export const RG_FILES_FLAGS = ["--files", "--color=never", "--glob=!.git/*", "--no-messages"]

export const DEFAULT_MAX_FILESIZE = "10M"
export const DEFAULT_MAX_COUNT = 500
export const DEFAULT_MAX_COLUMNS = 1000
export const GREP_MAX_OUTPUT_BYTES = 256 * 1024
export const RG_SAFETY_FLAGS = [
  "--no-follow",
  "--color=never",
  "--no-heading",
  "--line-number",
  "--with-filename",
  "--no-messages",
]
export const GREP_SAFETY_FLAGS = ["-n", "-H", "--color=never"]

export function buildGlobRgArgs(options) {
  const args = [
    ...RG_FILES_FLAGS,
    `--threads=${Math.min(options.threads ?? DEFAULT_RG_THREADS, DEFAULT_RG_THREADS)}`,
    `--max-depth=${Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH)}`,
  ]
  if (options.hidden !== false) args.push("--hidden")
  if (options.follow !== false) args.push("--follow")
  if (options.noIgnore) args.push("--no-ignore")
  args.push(`--glob=${options.pattern}`)
  return args
}

export function buildFindArgs(options) {
  const args = []
  if (options.follow !== false) args.push("-L")
  args.push(".")
  const maxDepth = Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH)
  args.push("-maxdepth", String(maxDepth))
  args.push("-type", "f")
  args.push("-name", options.pattern)
  if (options.hidden === false) args.push("-not", "-path", "*/.*")
  return args
}

export function buildPowerShellCommand(options) {
  const maxDepth = Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH)
  const paths = options.paths?.length ? options.paths : ["."]
  const searchPath = paths[0] || "."
  const escapedPath = searchPath.replace(/'/g, "''")
  const escapedPattern = options.pattern.replace(/'/g, "''")
  let command = `Get-ChildItem -LiteralPath '${escapedPath}' -File -Recurse -Depth ${maxDepth - 1} -Filter '${escapedPattern}'`
  if (options.hidden !== false) command += " -Force"
  command += " -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"
  return ["powershell.exe", "-NoProfile", "-Command", command]
}

export function buildGrepRgArgs(options) {
  const args = [
    ...RG_SAFETY_FLAGS,
    `--threads=${Math.min(options.threads ?? DEFAULT_RG_THREADS, DEFAULT_RG_THREADS)}`,
    `--max-depth=${Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH)}`,
    `--max-filesize=${options.maxFilesize ?? DEFAULT_MAX_FILESIZE}`,
    `--max-count=${Math.min(options.maxCount ?? DEFAULT_MAX_COUNT, DEFAULT_MAX_COUNT)}`,
    `--max-columns=${Math.min(options.maxColumns ?? DEFAULT_MAX_COLUMNS, DEFAULT_MAX_COLUMNS)}`,
  ]
  if (options.context !== undefined && options.context > 0) args.push(`-C${Math.min(options.context, 10)}`)
  if (options.caseSensitive) args.push("--case-sensitive")
  if (options.wholeWord) args.push("-w")
  if (options.fixedStrings) args.push("-F")
  if (options.multiline) args.push("-U")
  if (options.hidden) args.push("--hidden")
  if (options.noIgnore) args.push("--no-ignore")
  if (options.fileType?.length) for (const type of options.fileType) args.push(`--type=${type}`)
  if (options.globs) for (const glob of options.globs) args.push(`--glob=${glob}`)
  if (options.excludeGlobs) for (const glob of options.excludeGlobs) args.push(`--glob=!${glob}`)
  if (options.outputMode === "files_with_matches") args.push("--files-with-matches")
  else if (options.outputMode === "count") args.push("--count")
  return args
}

export function buildGrepArgs(options) {
  const args = [...GREP_SAFETY_FLAGS, "-r"]
  if (options.context !== undefined && options.context > 0) args.push(`-C${Math.min(options.context, 10)}`)
  if (!options.caseSensitive) args.push("-i")
  if (options.wholeWord) args.push("-w")
  if (options.fixedStrings) args.push("-F")
  if (options.globs?.length) for (const glob of options.globs) args.push(`--include=${glob}`)
  if (options.excludeGlobs?.length) for (const glob of options.excludeGlobs) args.push(`--exclude=${glob}`)
  args.push("--exclude-dir=.git", "--exclude-dir=node_modules")
  return args
}

export function buildArgs(options, backend) {
  return backend === "rg" ? buildGrepRgArgs(options) : buildGrepArgs(options)
}

const defaultSpawner = (command, options) => spawn(command[0], command.slice(1), options)

export function collectSearchProcessOutput(proc, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill()
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
      reject(new Error(timeoutMessage))
    }, timeoutMs)
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    proc.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    proc.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 0 })
    })
  })
}

async function getFileMtime(filePath) {
  try {
    return (await stat(filePath)).mtime.getTime()
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return 0
  }
}

export async function runRgFiles(options, { cli, spawner = defaultSpawner, platform = process.platform, semaphore = rgSemaphore } = {}) {
  await semaphore.acquire()
  try {
    return await runRgFilesInternal(options, { cli, spawner, platform })
  } finally {
    semaphore.release()
  }
}

async function runRgFilesInternal(options, { cli, spawner, platform }) {
  const timeout = Math.min(options.timeout ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT)
  const isRg = cli.backend === "rg"
  const isWindows = platform === "win32"
  let command
  let cwd
  if (isRg) {
    const args = buildGlobRgArgs(options)
    cwd = options.paths?.[0] || "."
    args.push(".")
    command = [cli.path, ...args]
  } else if (isWindows) {
    command = buildPowerShellCommand(options)
    cwd = undefined
  } else {
    const args = buildFindArgs(options)
    const paths = options.paths?.length ? options.paths : ["."]
    cwd = paths[0] || "."
    command = [cli.path, ...args]
  }
  try {
    const proc = spawner(command, { stdout: "pipe", stderr: "pipe", cwd })
    const { stdout, stderr, exitCode } = await collectSearchProcessOutput(proc, timeout, `Glob search timeout after ${timeout}ms`)
    if (exitCode > 1 && stderr.trim()) return { files: [], totalFiles: 0, truncated: false, error: stderr.trim() }
    const truncatedOutput = stdout.length >= DEFAULT_MAX_OUTPUT_BYTES
    const outputToProcess = truncatedOutput ? stdout.substring(0, DEFAULT_MAX_OUTPUT_BYTES) : stdout
    const lines = outputToProcess.trim().split("\n").filter(Boolean)
    const files = []
    let truncated = false
    for (const line of lines) {
      if (files.length >= limit) {
        truncated = true
        break
      }
      let filePath
      if (isRg) filePath = cwd ? path.resolve(cwd, line) : line
      else if (isWindows) filePath = line.trim()
      else filePath = `${cwd}/${line}`
      files.push({ path: filePath, mtime: await getFileMtime(filePath) })
    }
    files.sort((a, b) => b.mtime - a.mtime)
    return { files, totalFiles: files.length, truncated: truncated || truncatedOutput }
  } catch (error) {
    return { files: [], totalFiles: 0, truncated: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function parseOutput(output, filesOnly = false) {
  if (!output.trim()) return []
  const matches = []
  for (let line of output.split("\n")) {
    line = line.replace(/\r$/, "")
    if (!line.trim()) continue
    if (filesOnly) {
      matches.push({ file: line.trim(), line: 0, text: "" })
      continue
    }
    const match = line.match(/^([A-Za-z]:[\\/].*?|.+?):(\d+):(.*)$/)
    if (match) matches.push({ file: match[1], line: parseInt(match[2], 10), text: match[3] })
  }
  return matches
}

export function parseCountOutput(output) {
  if (!output.trim()) return []
  const results = []
  for (let line of output.split("\n")) {
    line = line.replace(/\r$/, "")
    if (!line.trim()) continue
    const match = line.match(/^([A-Za-z]:[\\/].*?|.+?):(\d+)$/)
    if (match) results.push({ file: match[1], count: parseInt(match[2], 10) })
  }
  return results
}

export async function runRg(options, { cli, spawner = defaultSpawner, semaphore = rgSemaphore } = {}) {
  await semaphore.acquire()
  try {
    return await runRgInternal(options, { cli, spawner })
  } finally {
    semaphore.release()
  }
}

async function runRgInternal(options, { cli, spawner }) {
  const args = buildArgs(options, cli.backend)
  const timeout = Math.min(options.timeout ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  if (cli.backend === "rg") args.push("--", options.pattern)
  else args.push("-e", options.pattern)
  const paths = options.paths?.length ? options.paths : ["."]
  args.push(...paths)
  try {
    const proc = spawner([cli.path, ...args], { stdout: "pipe", stderr: "pipe" })
    const { stdout, stderr, exitCode } = await collectSearchProcessOutput(proc, timeout, `Search timeout after ${timeout}ms`)
    const truncated = stdout.length >= GREP_MAX_OUTPUT_BYTES
    const outputToProcess = truncated ? stdout.substring(0, GREP_MAX_OUTPUT_BYTES) : stdout
    if (exitCode > 1 && stderr.trim()) return { matches: [], totalMatches: 0, filesSearched: 0, truncated: false, error: stderr.trim() }
    const matches = parseOutput(outputToProcess, options.outputMode === "files_with_matches")
    const limited = options.headLimit && options.headLimit > 0 ? matches.slice(0, options.headLimit) : matches
    const filesSearched = new Set(limited.map((match) => match.file)).size
    return {
      matches: limited,
      totalMatches: limited.length,
      filesSearched,
      truncated: truncated || (options.headLimit ? matches.length > options.headLimit : false),
    }
  } catch (error) {
    return { matches: [], totalMatches: 0, filesSearched: 0, truncated: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runRgCount(options, { cli, spawner = defaultSpawner, semaphore = rgSemaphore } = {}) {
  await semaphore.acquire()
  try {
    return await runRgCountInternal(options, { cli, spawner })
  } finally {
    semaphore.release()
  }
}

async function runRgCountInternal(options, { cli, spawner }) {
  const args = buildArgs({ ...options, context: 0 }, cli.backend)
  if (cli.backend === "rg") args.push("--count", "--", options.pattern)
  else args.push("-c", "-e", options.pattern)
  const paths = options.paths?.length ? options.paths : ["."]
  args.push(...paths)
  const timeout = Math.min(options.timeout ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  try {
    const proc = spawner([cli.path, ...args], { stdout: "pipe", stderr: "pipe" })
    const { stdout, stderr, exitCode } = await collectSearchProcessOutput(proc, timeout, `Search timeout after ${timeout}ms`)
    if (exitCode > 1 && stderr.trim()) throw new Error(stderr.trim())
    return parseCountOutput(stdout)
  } catch (error) {
    throw new Error(`Count search failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
