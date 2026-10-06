// Resolver for the search backend, a faithful port of the V1
// `packages/omo-opencode/src/shared/ripgrep-cli.ts`. It preserves the complete
// resolution ladder (OpenCode-bundled rg, PATH rg, previously installed rg, GNU
// grep fallback) and the auto-provisioning path, so the native glob/grep tools
// keep V1's capability on a host without ripgrep. All side effects are
// injectable for hermetic tests.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { downloadAndInstallRipgrep, getRgPath } from "./glob-grep-install.mjs"

function getFirstExecutablePath(stdout) {
  return (
    String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

export function createCliResolver(options = {}) {
  const fs = options.fs ?? { existsSync }
  const runSync = options.spawnSync ?? spawnSync
  const env = options.env ?? process.env
  const homedir = options.homedir ?? os.homedir()
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const execPath = options.execPath ?? process.execPath
  const pathModule = options.pathModule ?? path
  const install =
    options.install ??
    (() => downloadAndInstallRipgrep({ homedir, platform, arch, pathModule, spawnImpl: options.spawnImpl, fetchImpl: options.fetchImpl }))
  let cached = null
  let autoInstallAttempted = false

  function findExecutable(name) {
    const isWindows = platform === "win32"
    const command = isWindows ? "where.exe" : "which"
    try {
      const result = runSync(command, [name], { encoding: "utf-8", timeout: 5000, windowsHide: isWindows, shell: false })
      if (result.status === 0 && result.stdout && result.stdout.trim()) return getFirstExecutablePath(result.stdout)
    } catch (error) {
      if (error instanceof Error) return null
      return null
    }
    return null
  }

  function getBundledRg() {
    const rgName = platform === "win32" ? "rg.exe" : "rg"
    const cacheHome = env.XDG_CACHE_HOME ?? pathModule.join(homedir, ".cache")
    const dataHome = env.XDG_DATA_HOME ?? pathModule.join(homedir, ".local", "share")
    const execDir = pathModule.dirname(execPath)
    const candidates = [
      pathModule.join(cacheHome, "opencode", "bin", rgName),
      pathModule.join(dataHome, "opencode", "bin", rgName),
      pathModule.join(execDir, rgName),
      pathModule.join(execDir, "bin", rgName),
      pathModule.join(execDir, "..", "bin", rgName),
      pathModule.join(execDir, "..", "libexec", rgName),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return null
  }

  function getInstalledRipgrepPath() {
    const rgPath = getRgPath(homedir, platform)
    return fs.existsSync(rgPath) ? rgPath : null
  }

  function resolve() {
    if (cached) return cached
    const rgPath = getBundledRg() ?? findExecutable("rg") ?? getInstalledRipgrepPath()
    if (rgPath) {
      cached = { path: rgPath, backend: "rg" }
      return cached
    }
    const grep = findExecutable("grep")
    if (grep) {
      cached = { path: grep, backend: "grep" }
      return cached
    }
    cached = { path: "rg", backend: "rg" }
    return cached
  }

  async function resolveWithAutoInstall() {
    const current = resolve()
    if (current.backend === "rg" && current.path !== "rg") return current
    if (autoInstallAttempted) return current
    autoInstallAttempted = true
    try {
      const rgPath = await install()
      cached = { path: rgPath, backend: "rg" }
      return cached
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return current
    }
  }

  return { resolve, resolveWithAutoInstall, findExecutable, getBundledRg, getInstalledRipgrepPath }
}
