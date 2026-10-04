import fs from "node:fs"
import path from "node:path"

/**
 * Discover every ESM module the native V2 entry transitively imports from the
 * source tree. The deployed runtime, the activation script, and the isolated QA
 * contracts all copy the same set from this one function, so a newly added
 * module can never be silently dropped by a hand-maintained list (the failure
 * mode that makes the lab runtime fail to import a module after an edit).
 *
 * Returns repo-forward-slash relative paths, sorted, excluding the entry module
 * itself: callers place that one as the plugin entry (`index.js`).
 */
export function discoverRuntimeModules(sourceOpenDir, entry = "rigel-v2-native.mjs") {
  const seen = new Set()
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) continue
    const absolute = path.join(sourceOpenDir, file)
    if (!fs.existsSync(absolute)) continue
    seen.add(file)
    const text = fs.readFileSync(absolute, "utf8")
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      let target = match[1]
      if (!target.endsWith(".mjs")) target += ".mjs"
      stack.push(path.normalize(path.join(path.dirname(file), target)).split(path.sep).join("/"))
    }
  }
  return [...seen].filter((file) => file !== entry).sort()
}
