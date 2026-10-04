const EDIT_ERROR_PATTERNS = [
  "oldstring and newstring must be different",
  "oldstring not found",
  "oldstring found multiple times",
  // OpenCode V2 edit-tool failure phrasings (verified live against the real runtime).
  "could not find oldstring",
  "oldstring must match exactly",
  "found multiple matches for oldstring",
]
const JSON_ERROR_TOOL_EXCLUDE_LIST = new Set([
  "bash", "read", "glob", "grep", "webfetch", "look_at", "grep_app_searchgithub", "websearch_web_search_exa",
  "todowrite", "todoread", "task", "rigel_task", "call_omo_agent", "background_output", "session_read",
  "session_search", "session_info", "session_list", "skill", "skill_mcp", "shell",
])
const JSON_ERROR_PATTERNS = [
  /json parse error/i, /failed to parse json/i, /invalid json/i, /malformed json/i,
  /unexpected end of json input/i, /syntaxerror:\s*unexpected token.*json/i,
  /json[^\n]*expected '\}'/i, /json[^\n]*unexpected eof/i,
]

const EDIT_ERROR_REMINDER = `
[EDIT ERROR - IMMEDIATE ACTION REQUIRED]

You made an Edit mistake. STOP and do this NOW:

1. READ the file immediately to see its ACTUAL current state
2. VERIFY what the content really looks like (your assumption was wrong)
3. APOLOGIZE briefly to the user for the error
4. CONTINUE with corrected action based on the real file content

DO NOT attempt another edit until you've read and verified the file state.
`

const JSON_ERROR_REMINDER = `
[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]

You sent invalid JSON arguments. The system could not parse your tool call.
STOP and do this NOW:

1. LOOK at the error message above to see what was expected vs what you sent.
2. CORRECT your JSON syntax (missing braces, unescaped quotes, trailing commas, etc).
3. RETRY the tool call with valid JSON.

DO NOT repeat the exact same invalid call.
`

function partTexts(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
  return ""
}

const JSON_ERROR_REMINDER_MARKER = "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]"

/**
 * The V2 post-tool event differs by outcome: a success carries `result.content`
 * (string or text-part array), a failure carries `status: "error"` with the
 * message on `error` (string or `{message}`) and/or `result.error`/`output`.
 * V1 matched the tool output regardless of status; this extractor does the same
 * so a REAL editor or host failure is not silently missed.
 */
export function recoveryText(event) {
  if (!event || typeof event !== "object") return ""
  const parts = [
    partTexts(event.result?.content),
    partTexts(event.result?.error),
    typeof event.result?.error === "string" ? event.result.error : "",
    typeof event.result?.error?.message === "string" ? event.result.error.message : "",
    typeof event.result?.output === "string" ? event.result.output : "",
    typeof event.error === "string" ? event.error : "",
    typeof event.error?.message === "string" ? event.error.message : "",
    typeof event.output === "string" ? event.output : "",
    typeof event.message === "string" ? event.message : "",
  ]
  return parts.filter(Boolean).join("\n")
}

function appendToResult(result, text) {
  if (typeof result?.content === "string") { result.content += text; return true }
  if (Array.isArray(result?.content)) { result.content.push({ type: "text", text }); return true }
  return false
}

/** Append the reminder to whichever mutable channel the event exposes. */
function appendReminder(event, text) {
  if (appendToResult(event.result, text)) return true
  if (typeof event.output === "string") { event.output += text; return true }
  if (typeof event.error === "string") { event.error += text; return true }
  if (event.error && typeof event.error === "object" && typeof event.error.message === "string") { event.error.message += text; return true }
  if (event.result && typeof event.result === "object") {
    if (typeof event.result.output === "string") { event.result.output += text; return true }
    if (typeof event.result.error === "string") { event.result.error += text; return true }
    event.result.content = text
    return true
  }
  return false
}

/** Native V2 equivalent for V1's post-tool recovery hints (edit + JSON). */
export function applyNativeRecoveryReminder(event) {
  if (!event || typeof event !== "object") return false
  const tool = String(event.tool ?? "").toLowerCase()
  const text = recoveryText(event)
  if (!text) return false
  if (tool === "edit" && EDIT_ERROR_PATTERNS.some((pattern) => text.toLowerCase().includes(pattern))) {
    return appendReminder(event, EDIT_ERROR_REMINDER)
  }
  if (!JSON_ERROR_TOOL_EXCLUDE_LIST.has(tool) && !text.includes(JSON_ERROR_REMINDER_MARKER) && JSON_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    return appendReminder(event, JSON_ERROR_REMINDER)
  }
  return false
}
