const EDIT_ERROR_PATTERNS = [
  "oldstring and newstring must be different",
  "oldstring not found",
  "oldstring found multiple times",
]
const JSON_ERROR_TOOL_EXCLUDE_LIST = new Set([
  "bash", "read", "glob", "grep", "webfetch", "look_at", "grep_app_searchgithub", "websearch_web_search_exa",
  "todowrite", "todoread", "task", "rigel_task", "call_omo_agent", "background_output", "session_read",
  "session_search", "session_info", "session_list", "skill", "skill_mcp",
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

function resultText(result) {
  if (typeof result?.content === "string") return result.content
  if (Array.isArray(result?.content)) return result.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
  return ""
}

function append(result, text) {
  if (typeof result?.content === "string") {
    result.content += text
    return true
  }
  if (Array.isArray(result?.content)) {
    result.content.push({ type: "text", text })
    return true
  }
  return false
}

/** Native V2 equivalent for V1's post-tool recovery hints. */
export function applyNativeRecoveryReminder(event) {
  if (event?.status !== "completed") return false
  const tool = String(event.tool ?? "").toLowerCase()
  const text = resultText(event.result)
  if (tool === "edit" && EDIT_ERROR_PATTERNS.some((pattern) => text.toLowerCase().includes(pattern))) {
    return append(event.result, EDIT_ERROR_REMINDER)
  }
  if (!JSON_ERROR_TOOL_EXCLUDE_LIST.has(tool) && !text.includes("[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]") && JSON_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    return append(event.result, JSON_ERROR_REMINDER)
  }
  return false
}
