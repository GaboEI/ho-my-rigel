import fs from "node:fs"

const CHILD_TASK_MARKER = "<rigel-native-child-task>"
const ULTRAWORK_MARKER = "<rigel-native-ultrawork>"
const ultraworkKeyword = /\b(?:ultrawork|ulw)\b/i

export function loadUltraworkDirective() {
  const bundled = new URL("./prompts/ultrawork-default.md", import.meta.url)
  const checkout = new URL("../../../packages/prompts-core/prompts/ultrawork/default.md", import.meta.url)
  for (const source of [bundled, checkout]) {
    try { return fs.readFileSync(source, "utf8") } catch { /* try the next package location */ }
  }
  throw new Error("Rigel native V2 ultrawork directive is unavailable")
}

export function childTaskPrompt(prompt) {
  return `${CHILD_TASK_MARKER}\n${String(prompt)}`
}

export function createNativePromptHook({ ultraworkDirective, defaultUltrawork = true } = {}) {
  if (typeof ultraworkDirective !== "string" || ultraworkDirective.length === 0) {
    throw new TypeError("A native ultrawork directive is required")
  }
  const injectedSessions = new Set()
  return async (input) => {
    if (!input?.prompt || typeof input.prompt !== "object" || typeof input.prompt.text !== "string") return
    const text = input.prompt.text
    if (text.startsWith(CHILD_TASK_MARKER)) {
      input.prompt.text = text.slice(CHILD_TASK_MARKER.length).trimStart()
      return
    }
    const sessionID = typeof input.sessionID === "string" ? input.sessionID : "unknown"
    const explicit = ultraworkKeyword.test(text)
    if ((!defaultUltrawork && !explicit) || injectedSessions.has(sessionID) || text.includes(ULTRAWORK_MARKER)) return
    injectedSessions.add(sessionID)
    input.prompt.text = `${text}\n\n${ULTRAWORK_MARKER}\n${ultraworkDirective}\n${ULTRAWORK_MARKER}`
  }
}
