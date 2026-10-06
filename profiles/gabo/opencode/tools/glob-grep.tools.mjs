// Native OpenCode V2 `glob` and `grep` tools. These reproduce the V1 public
// contract exactly (`packages/omo-opencode/src/tools/glob/tools.ts` and
// `.../grep/tools.ts`) and are registered under the same names, overriding the
// host builtin whose defaults, formats, follow/depth behavior, output modes and
// per-file limits diverge from V1. Backend resolution (bundled rg, PATH rg,
// installed rg, GNU grep fallback), auto-provisioning and the concurrency cap
// are preserved through `glob-grep-cli.mjs`, `glob-grep-install.mjs` and
// `glob-grep-concurrency.mjs`. The same observable call the model made in V1
// therefore produces the same result, with no extra options required.
import path from "node:path"
import { createCliResolver } from "./glob-grep-cli.mjs"
import { runRg, runRgCount, runRgFiles } from "./glob-grep-search.mjs"
import { formatCountResult, formatGlobResult, formatGrepResult } from "./glob-grep-format.mjs"

export const GLOB_DESCRIPTION =
  "Fast file pattern matching tool with safety limits (60s timeout, 100 file limit). " +
  'Supports glob patterns like "**/*.js" or "src/**/*.ts". ' +
  "Returns matching file paths sorted by modification time. " +
  "Use this tool when you need to find files by name patterns."

export const GREP_DESCRIPTION =
  "Fast content search tool with safety limits (60s timeout, 256KB output). " +
  "Searches file contents using regular expressions. " +
  'Supports full regex syntax (eg. "log.*Error", "function\\\\s+\\\\w+", etc.). ' +
  'Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}"). ' +
  'Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts per file.'

export const GLOB_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "The glob pattern to match files against" },
    path: {
      type: "string",
      description:
        "The directory to search in. If not specified, the current working directory will be used. " +
        "IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - " +
        "simply omit it for the default behavior. Must be a valid directory path if provided.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
}

export const GREP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "The regex pattern to search for in file contents" },
    include: { type: "string", description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")' },
    path: { type: "string", description: "The directory to search in. Defaults to the current working directory." },
    output_mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"],
      description:
        'Output mode: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts per file.',
    },
    head_limit: { type: "number", description: "Limit output to first N entries. 0 or omitted means no limit." },
  },
  required: ["pattern"],
  additionalProperties: false,
}

function resolveDirectory(directory, context) {
  if (typeof context?.directory === "string" && context.directory) return context.directory
  if (typeof directory === "string" && directory) return directory
  return process.cwd()
}

export function createGlobTool({
  directory,
  resolver = createCliResolver(),
  spawner,
  platform,
  semaphore,
  run = runRgFiles,
} = {}) {
  return {
    name: "glob",
    options: { codemode: false },
    description: GLOB_DESCRIPTION,
    input: GLOB_INPUT_SCHEMA,
    execute: async (input, context) => {
      try {
        const cli = await resolver.resolveWithAutoInstall()
        const dir = resolveDirectory(directory, context)
        const searchPath = input.path ? path.resolve(dir, input.path) : dir
        const result = await run({ pattern: input.pattern, paths: [searchPath] }, { cli, spawner, platform, semaphore })
        return { content: formatGlobResult(result), metadata: { count: result.totalFiles, truncated: result.truncated } }
      } catch (error) {
        return { content: `Error: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

export function createGrepTool({
  directory,
  resolver = createCliResolver(),
  spawner,
  platform,
  semaphore,
  run = runRg,
  runCount = runRgCount,
} = {}) {
  return {
    name: "grep",
    options: { codemode: false },
    description: GREP_DESCRIPTION,
    input: GREP_INPUT_SCHEMA,
    execute: async (input, context) => {
      try {
        const cli = await resolver.resolveWithAutoInstall()
        const dir = resolveDirectory(directory, context)
        const searchPath = input.path ? path.resolve(dir, input.path) : dir
        const paths = [searchPath]
        const globs = input.include ? [input.include] : undefined
        const outputMode = input.output_mode ?? "files_with_matches"
        const headLimit = input.head_limit ?? 0
        if (outputMode === "count") {
          const results = await runCount({ pattern: input.pattern, paths, globs }, { cli, spawner, semaphore })
          const limited = headLimit > 0 ? results.slice(0, headLimit) : results
          return { content: formatCountResult(limited) }
        }
        const result = await run({ pattern: input.pattern, paths, globs, context: 0, outputMode, headLimit }, { cli, spawner, semaphore })
        return { content: formatGrepResult(result), metadata: { matches: result.totalMatches, truncated: result.truncated } }
      } catch (error) {
        return { content: `Error: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

// A single resolver shared by both tools, matching V1's module-level cache.
export function createGlobGrepTools(options = {}) {
  const resolver = options.resolver ?? createCliResolver()
  return [createGlobTool({ ...options, resolver }), createGrepTool({ ...options, resolver })]
}
