/**
 * Native V2 tmux visualization: command runner and OpenCode server health
 * (rewrite of V1 `tmux-core/runner.ts` + `server-health.ts`).
 *
 * The tmux CLI is executed as a plain subprocess (V1 parity: it is a
 * non-interactive control client, so no PTY is required). `createTmuxVizRunner`
 * accepts an injected `spawnImpl` so tests drive a scripted tmux without a
 * real binary.
 */

import { spawn } from "node:child_process"

const SERVER_HEALTH_TIMEOUT_MS = 3000
const SERVER_HEALTH_ATTEMPTS = 2
const SERVER_HEALTH_RETRY_DELAY_MS = 250

export function createTmuxVizRunner({ tmuxPath, spawnImpl } = {}) {
  if (typeof tmuxPath !== "string" || !tmuxPath) throw new Error("tmuxPath is required for the tmux visualization runner")
  const spawnFn = spawnImpl ?? ((args, options) => {
    const child = spawn(tmuxPath, args, { stdio: ["ignore", "pipe", "pipe"], ...options })
    return {
      exitCode: new Promise((resolve, reject) => {
        child.on("error", reject)
        child.on("exit", (code) => resolve(code ?? 1))
      }),
      stdout: new Promise((resolve) => { let out = ""; child.stdout.on("data", (chunk) => { out += chunk }); child.stdout.on("end", () => resolve(out)) }),
      stderr: new Promise((resolve) => { let err = ""; child.stderr.on("data", (chunk) => { err += chunk }); child.stderr.on("end", () => resolve(err)) }),
    }
  })
  return {
    tmuxPath,
    async run(args, options = {}) {
      const child = spawnFn([...args], options)
      const [exitCode, stdout, stderr] = await Promise.all([child.exitCode, child.stdout, child.stderr])
      return { exitCode, stdout, stderr }
    },
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * V1 `isServerRunning` parity: `GET <serverUrl>/global/health` with a short
 * timeout, two attempts, an in-process marker set once the plugin knows the
 * server it lives in, and a process-lifetime cache. A negative result is NOT
 * cached forever: `resetServerHealthCache()` exists for tests and reconnects.
 */
export function createServerHealthProbe({ fetchImpl = fetch, marker = globalThis } = {}) {
  const cache = new Map()
  const markerKey = "opencodeServerRunningInProcess"
  return {
    markServerRunningInProcess() { marker[markerKey] = true },
    async isServerRunning(serverUrl) {
      if (marker[markerKey] === true) return true
      if (typeof serverUrl !== "string" || !serverUrl) return false
      if (cache.has(serverUrl)) return cache.get(serverUrl)
      for (let attempt = 0; attempt < SERVER_HEALTH_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await sleep(SERVER_HEALTH_RETRY_DELAY_MS)
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), SERVER_HEALTH_TIMEOUT_MS)
          const response = await fetchImpl(new URL("/global/health", serverUrl), { signal: controller.signal })
          clearTimeout(timeout)
          if (response.ok) {
            cache.set(serverUrl, true)
            return true
          }
        } catch { /* retry, then fall through to a negative verdict */ }
      }
      cache.set(serverUrl, false)
      return false
    },
    resetServerHealthCache() { cache.clear() },
  }
}
