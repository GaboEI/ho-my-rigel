// Auto-provisioning of the ripgrep binary, a faithful port of
// `packages/omo-opencode/src/tools/grep/downloader.ts`. The native glob/grep
// tools call the resolver with auto-install exactly like V1, so a host without
// ripgrep can still provision it instead of losing the rg capability. Every
// side effect is injectable so the contract is testable without network or disk.
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"

export const RG_VERSION = "14.1.1"
export const CACHE_DIR_NAME = "oh-my-opencode"

export const PLATFORM_CONFIG = {
  "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
  "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
  "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
  "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
}

export function getInstallDir(homedir) {
  return path.join(homedir, ".cache", CACHE_DIR_NAME, "bin")
}

export function getRgPath(homedir, platform) {
  return path.join(getInstallDir(homedir), platform === "win32" ? "rg.exe" : "rg")
}

async function defaultDownload(url, archivePath, { fetchImpl, fs }) {
  const response = await fetchImpl(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()))
}

function runProcess(spawnImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(command, args, { cwd: options.cwd, stdio: "ignore" })
    proc.on("error", reject)
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))))
  })
}

async function defaultUnpack(archivePath, destDir, { extension, platformKey, spawnImpl, fs, pathModule }) {
  if (extension === "zip") {
    await runProcess(spawnImpl, "unzip", ["-o", archivePath, "-d", destDir], { cwd: destDir })
    return
  }
  const args = ["-xzf", archivePath, "--strip-components=1"]
  if (platformKey.endsWith("-darwin")) args.push("--include=*/rg")
  else if (platformKey.endsWith("-linux")) args.push("--wildcards", "*/rg")
  await runProcess(spawnImpl, "tar", args, { cwd: destDir })
}

/**
 * Downloads and extracts ripgrep into `$HOME/.cache/oh-my-opencode/bin`, exactly
 * like V1. Returns the resolved rg path. Every dependency is injectable.
 */
export async function downloadAndInstallRipgrep(options = {}) {
  const fs = options.fs ?? { existsSync, mkdirSync, chmodSync, unlinkSync, writeFileSync }
  const homedir = options.homedir ?? os.homedir()
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const pathModule = options.pathModule ?? path
  const spawnImpl = options.spawnImpl ?? spawn
  const fetchImpl = options.fetchImpl ?? fetch
  const version = options.version ?? RG_VERSION
  const configMap = options.configMap ?? PLATFORM_CONFIG
  const download = options.download ?? defaultDownload
  const unpack = options.unpack ?? defaultUnpack

  const platformKey = `${arch}-${platform}`
  const config = configMap[platformKey]
  if (!config) throw new Error(`Unsupported platform: ${platformKey}`)

  const installDir = getInstallDir(homedir)
  const rgPath = getRgPath(homedir, platform)
  if (fs.existsSync(rgPath)) return rgPath

  fs.mkdirSync(installDir, { recursive: true })
  const filename = `ripgrep-${version}-${config.platform}.${config.extension}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${filename}`
  const archivePath = pathModule.join(installDir, filename)
  try {
    await download(url, archivePath, { fetchImpl, fs })
    await unpack(archivePath, installDir, { extension: config.extension, platformKey, spawnImpl, fs, pathModule })
    if (platform !== "win32" && fs.existsSync(rgPath)) fs.chmodSync(rgPath, 0o755)
    if (!fs.existsSync(rgPath)) throw new Error("ripgrep binary not found after extraction")
    return rgPath
  } finally {
    try {
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath)
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
}
