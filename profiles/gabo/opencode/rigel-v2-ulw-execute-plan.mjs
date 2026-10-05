import { readdirSync } from "node:fs"
import { basename, join } from "node:path"

export function getPlanName(planPath) {
  return basename(planPath, ".md")
}

export function discoverPlans(directory) {
  const root = join(directory, ".omo", "plans")
  try {
    return readdirSync(root).filter((entry) => entry.endsWith(".md")).map((entry) => join(root, entry))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

export function selectPlanByName(available, requested) {
  if (!requested) return available.length === 1 ? available[0] : null
  const needle = requested.toLowerCase().replace(/[-_\s]+/g, "")
  return available.find((candidate) => getPlanName(candidate).toLowerCase().replace(/[-_\s]+/g, "") === needle)
    ?? available.find((candidate) => getPlanName(candidate).toLowerCase().replace(/[-_\s]+/g, "").includes(needle))
    ?? null
}

export function findRecentSessionPlanPath(messages, available) {
  const paths = new Set(available)
  for (const message of [...messages].reverse()) {
    const text = typeof message === "string" ? message : JSON.stringify(message)
    for (const path of paths) if (text.includes(path)) return path
  }
  return null
}
