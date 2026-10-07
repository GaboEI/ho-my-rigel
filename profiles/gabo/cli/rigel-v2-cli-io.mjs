// Shared I/O, argument parsing and output helpers for the Rigel V2 CLI.
//
// The CLI is materialized into the isolated V2 laboratory
// (`<labRoot>/rigel/bin/rigel-v2`), whose launcher exports the lab HOME/XDG
// before running this code, so the default `io` resolves inside the lab and
// never at V1. Every command receives an injectable `io` so the CLI can be
// driven hermetically in tests (captured stdout/stderr, a temp home/env, an
// injected spawn/fetch) without launching OpenCode or touching V1.

import { spawnSync } from "node:child_process"
import os from "node:os"

export function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    home: os.homedir(),
    spawn: (command, args, options) => spawnSync(command, args, options),
  }
}

/**
 * Parse `--flag`, `--key value`, `--key=value` and positionals. A flag followed
 * by another `--` flag (or nothing) is boolean true.
 */
export function parseArgs(argv) {
  const positionals = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== "string") continue
    if (token.startsWith("--")) {
      const equals = token.indexOf("=")
      if (equals >= 0) {
        options[token.slice(2, equals)] = token.slice(equals + 1)
      } else {
        const key = token.slice(2)
        const next = argv[index + 1]
        if (next !== undefined && !next.startsWith("--")) {
          options[key] = next
          index += 1
        } else {
          options[key] = true
        }
      }
    } else {
      positionals.push(token)
    }
  }
  return { positionals, options }
}

export function truthy(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value
  return normalized === "1" || normalized === "true"
}

export function writeJson(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function fail(io, message) {
  io.stderr.write(`[rigel-v2] ${message}\n`)
  return 1
}

/** Exit code that a child process result maps to (status ?? 1). */
export function exitCodeOf(result) {
  return typeof result?.status === "number" ? result.status : 1
}
