import fs from "node:fs"
import path from "node:path"
import { patchToolArgs } from "./rigel-v2-native-tool-args.mjs"

const MAX_SESSIONS = 256
const MAX_PATHS_PER_SESSION = 1024

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function canonical(file) {
  try { return fs.existsSync(file) ? fs.realpathSync.native(file) : path.resolve(file) } catch { return path.resolve(file) }
}

function pathArgument(input) {
  const args = input?.input ?? input?.args ?? {}
  const candidate = args.path ?? args.filePath ?? args.file_path
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined
}

/** Native V2 replacement for the V1 read-before-overwrite guard. */
export function createNativeWriteExistingFileGuard({ directory } = {}) {
  const workspace = canonical(path.resolve(directory ?? process.cwd()))
  const permissions = new Map()
  const state = (sessionID) => {
    if (!permissions.has(sessionID)) {
      if (permissions.size >= MAX_SESSIONS) permissions.delete(permissions.keys().next().value)
      permissions.set(sessionID, new Set())
    }
    return permissions.get(sessionID)
  }
  return {
    before(event) {
      const tool = String(event?.tool ?? "").toLowerCase()
      if ((tool !== "read" && tool !== "write") || typeof event?.sessionID !== "string") return
      const argument = pathArgument(event)
      if (!argument) return
      const resolved = path.resolve(workspace, argument)
      const target = canonical(resolved)
      if (!inside(workspace, target)) return
      if (tool === "read") {
        if (fs.existsSync(resolved)) {
          const allowed = state(event.sessionID)
          allowed.delete(target)
          allowed.add(target)
          while (allowed.size > MAX_PATHS_PER_SESSION) allowed.delete(allowed.values().next().value)
        }
        return
      }
      if (!fs.existsSync(resolved)) return
      if (/(^|[/\\])\.omo([/\\]|$)/.test(target)) return
      const args = event.input ?? event.args
      const overwrite = args?.overwrite === true || String(args?.overwrite).toLowerCase() === "true"
      if (args && Object.hasOwn(args, "overwrite")) patchToolArgs(event, (target) => { delete target.overwrite })
      if (overwrite) return
      const allowed = state(event.sessionID)
      if (allowed.delete(target)) {
        for (const [otherSession, other] of permissions) if (otherSession !== event.sessionID) other.delete(target)
        return
      }
      throw new Error("File already exists. Use edit tool instead.")
    },
    clear(sessionID) { permissions.delete(sessionID) },
    clearAll() { permissions.clear() },
  }
}
