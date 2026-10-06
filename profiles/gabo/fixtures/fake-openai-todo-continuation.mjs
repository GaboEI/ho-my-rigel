import fs from "node:fs"
import http from "node:http"
import { pathToFileURL } from "node:url"

const port = Number(process.env.RIGEL_FAKE_MODEL_PORT ?? "41235")
const traceFile = process.env.RIGEL_FAKE_MODEL_TRACE
const toolNameOverride = process.env.RIGEL_FAKE_TOOL || undefined
let requestCount = 0

const CONTINUATION_MARKER = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]"
const TITLE_TEXT = "T22 todo continuity"
const CONTINUATION_TEXT = "CONTINUATION_ACK"
const FALLBACK_TEXT = "RIGEL_FAKE_NO_SCENARIO"
const COMPACTED_SUMMARY = `## Objective
- Delegate research.

## Requirements
- (none)

## Decisions
- (none)

## Work State
### Completed
- (none)

### Active
- Delegate research.

### Blocked
- (none)

## Next Move
1. Delegate the research.

## Relevant Files
- (none)

## Important Context
- (none)`

const ATLAS_BOOTSTRAP_TODOS = [
  { id: "orchestrate-plan", content: "Complete ALL implementation tasks", status: "pending", priority: "medium" },
  { id: "pass-final-wave", content: "Pass Final Verification Wave - ALL reviewers APPROVE", status: "pending", priority: "medium" },
]

const STORAGE_TODOS = [
  { id: "store-a", content: "Storage todo A", status: "pending", priority: "high" },
  { id: "store-b", content: "Storage todo B", status: "in_progress", priority: "medium" },
]

const SCENARIOS = {
  "storage-write": {
    finalText: "STORAGE_WRITE_DONE",
    steps: [
      { name: "todowrite", arguments: () => ({ todos: STORAGE_TODOS }) },
      { name: "session_read", arguments: ({ sessionID }) => ({ session_id: sessionID, include_todos: true }) },
    ],
  },
  // The unrelated todo is seeded through the TASK surface, not `todowrite`:
  // with `experimental.task_system` enabled the V1 config disables `todowrite`
  // (tool-config-handler.ts sets `todowrite: false` + a deny), so the only way
  // to have an unrelated todo under that gate is a second mirrored task. It is
  // created BEFORE the mirror so the mirror's `syncTodos` must preserve it.
  "task-mirror": {
    finalText: "TASK_MIRROR_DONE",
    steps: [
      { name: "task_create", arguments: () => ({ subject: "Unrelated todo must persist", status: "pending" }) },
      { name: "task_create", arguments: () => ({ subject: "Mirror task", status: "pending" }) },
      { name: "task_update", arguments: ({ taskID }) => ({ id: taskID, status: "completed" }) },
      { name: "session_read", arguments: ({ sessionID }) => ({ session_id: sessionID, include_todos: true }) },
      { name: "session_info", arguments: ({ sessionID }) => ({ session_id: sessionID }) },
    ],
  },
  compaction: {
    finalText: "COMPACTION_SEEDED",
    steps: [
      {
        name: "todowrite",
        arguments: () => ({ todos: [{ id: "detailed-1", content: "Detailed work item", status: "in_progress", priority: "high" }] }),
      },
    ],
  },
  "compaction-late": {
    finalText: "BOOTSTRAP_WRITTEN",
    steps: [{ name: "todowrite", arguments: () => ({ todos: ATLAS_BOOTSTRAP_TODOS }) }],
  },
  continuation: {
    finalText: "CONTINUATION_SEEDED",
    steps: [
      {
        name: "todowrite",
        arguments: () => ({ todos: [{ id: "c-1", content: "Continue me", status: "pending", priority: "medium" }] }),
      },
    ],
  },
  "continuation-complete": {
    finalText: "COMPLETE_SEEDED",
    steps: [
      {
        name: "todowrite",
        arguments: () => ({ todos: [{ id: "c-done", content: "Already done", status: "completed", priority: "medium" }] }),
      },
    ],
  },
  "idle-only": {
    // No tool call: an ordinary completed turn, used to drive one idle edge
    // without changing the todo list.
    finalText: "IDLE_ONLY_DONE",
    steps: [],
  },
  "question-pending": {
    // Seeds an incomplete todo, then leaves an open `question` tool call so the
    // transcript holds an unanswered question. The host answers it only when the
    // driver replies to the created form; the final turn then runs.
    finalText: "QUESTION_ANSWERED",
    steps: [
      {
        name: "todowrite",
        arguments: () => ({ todos: [{ id: "qp-1", content: "Question-blocked work", status: "in_progress", priority: "high" }] }),
      },
      {
        name: "question",
        arguments: () => ({
          questions: [
            {
              question: "Proceed with the blocked work?",
              header: "Proceed?",
              options: [
                { label: "Yes", description: "continue the work" },
                { label: "No", description: "stop the work" },
              ],
              multiple: false,
            },
          ],
        }),
      },
    ],
  },
  "continuation-slow": {
    // Same seed as `continuation`, but the final assistant turn stays open for
    // `finalDelayMs` so the driver can interrupt a genuinely running execution.
    finalText: "SLOW_DONE",
    finalDelayMs: 8000,
    steps: [
      {
        name: "todowrite",
        arguments: () => ({ todos: [{ id: "slow-1", content: "Interrupted work", status: "in_progress", priority: "high" }] }),
      },
    ],
  },
}

function contentToText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("\n")
  }
  if (content && typeof content.text === "string") return content.text
  if (content == null) return ""
  return JSON.stringify(content)
}

function countToolResults(messages) {
  let count = 0
  for (const message of messages) if (message?.role === "tool") count += 1
  return count
}

function latestUserMessageText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return contentToText(messages[index].content)
  }
  return ""
}

function sessionIdFromMessages(messages) {
  for (const message of messages) {
    const match = contentToText(message?.content).match(/session[_]?id\s*[:=]\s*["'`]?([A-Za-z0-9_-]+)/i)
    if (match) return match[1]
  }
  for (const message of messages) {
    const match = contentToText(message?.content).match(/\b(ses_[A-Za-z0-9]+)\b/)
    if (match) return match[1]
  }
  return undefined
}

function taskIdFromToolResults(messages) {
  // The LAST task id, so `task_update` targets the most recently created task
  // (the mirror) even when an earlier unrelated task exists.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "tool") continue
    const text = contentToText(message.content)
    const parsed = tryParseJson(text)
    const id = parsed?.task?.id ?? parsed?.id ?? parsed?.task_id
    if (typeof id === "string" && id.length > 0) return id
    const match = text.match(/"id"\s*:\s*"([^"]+)"/)
    if (match) return match[1]
  }
  return undefined
}

function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toolResultNames(messages) {
  const named = []
  for (const message of messages) {
    if (message?.role === "tool" && typeof message.name === "string") named.push(message.name)
  }
  if (named.length > 0) return named
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) if (call?.function?.name) named.push(call.function.name)
  }
  return named
}

export function scenarioFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const match = contentToText(list[index]?.content).match(/\[\[T22:([a-z0-9][a-z0-9-]*)\]\]/i)
    if (match) return match[1].toLowerCase()
  }
  return null
}

/**
 * Driver-supplied session correlation token. The driver embeds
 * `RIGEL-CORR:<token>` in a session's seed prompt; the token persists in the
 * transcript, so every later request of that session (including an injected
 * continuation) can be attributed to it even though the harness has no other
 * session identity on the provider request.
 */
export function correlationFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const match = contentToText(list[index]?.content).match(/RIGEL-CORR:([A-Za-z0-9-]+)/)
    if (match) return match[1]
  }
  return null
}

export function classifyRequest(messages, scenario) {
  const list = Array.isArray(messages) ? messages : []
  const systemText = list
    .filter((message) => message?.role === "system")
    .map((message) => contentToText(message.content))
    .join("\n")
  const latestUserText = latestUserMessageText(list)
  const sawContinuationMarker = latestUserText.includes(CONTINUATION_MARKER)
  const toolResultCount = countToolResults(list)
  const steps = SCENARIOS[scenario]?.steps ?? []
  const base = {
    scenario: scenario ?? null,
    latestUserText,
    sawContinuationMarker,
    toolResultCount,
    sessionID: sessionIdFromMessages(list) ?? null,
  }
  if (systemText.includes("You are a title generator")) return { ...base, kind: "title" }
  if (/^(You MUST summarize|Update the existing checkpoint|The previous response did not fill)/.test(latestUserText)) {
    return { ...base, kind: "compaction" }
  }
  if (sawContinuationMarker) return { ...base, kind: "continuation" }
  if (toolResultCount < steps.length) return { ...base, kind: "tool" }
  return { ...base, kind: "final" }
}

export function nextToolCall(messages, scenario, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const steps = SCENARIOS[scenario]?.steps ?? []
  const index = countToolResults(list)
  if (index >= steps.length) return null
  const step = steps[index]
  const context = {
    messages: list,
    sessionID: options.sessionID ?? sessionIdFromMessages(list) ?? "ses_fixture",
    taskID: taskIdFromToolResults(list),
  }
  const args = typeof step.arguments === "function" ? step.arguments(context) : step.arguments
  return { name: options.toolName ?? step.name, arguments: JSON.stringify(args) }
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function completionBase() {
  return { id: `chatcmpl_rigel_${requestCount}`, object: "chat.completion.chunk", created: 0, model: "rigel-fixture" }
}

function text(response, content) {
  writeSse(response, { ...completionBase(), choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })
  writeSse(response, { ...completionBase(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  response.end("data: [DONE]\n\n")
}

function toolCall(response, name, argumentsValue) {
  writeSse(response, {
    ...completionBase(),
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_rigel_t22", type: "function", function: { name, arguments: argumentsValue } }],
        },
        finish_reason: null,
      },
    ],
  })
  writeSse(response, { ...completionBase(), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  response.end("data: [DONE]\n\n")
}

function trace(value) {
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(value) + "\n")
}

function sessionIdFromRequest(request, payload) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const fromQuery = url.searchParams.get("sessionID") ?? url.searchParams.get("session_id")
  if (fromQuery) return fromQuery
  const fromBody = payload.sessionID ?? payload.session_id ?? payload.metadata?.sessionID ?? payload.metadata?.session_id
  if (typeof fromBody === "string" && fromBody) return fromBody
  return undefined
}

export function createFixtureServer() {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || !(request.url ?? "").startsWith("/v1/chat/completions")) {
      response.writeHead(404).end()
      return
    }
    let raw = ""
    for await (const chunk of request) raw += chunk
    const payload = JSON.parse(raw || "{}")
    requestCount += 1
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const scenario = scenarioFromMessages(messages)
    const classification = classifyRequest(messages, scenario)
    const sessionID = sessionIdFromRequest(request, payload) ?? classification.sessionID ?? undefined
    const call = nextToolCall(messages, scenario, { toolName: toolNameOverride, sessionID })
    trace({
      requestCount,
      scenario,
      sessionID: sessionID ?? null,
      correlation: correlationFromMessages(messages),
      responseKind: classification.kind,
      toolNames: payload.tools?.map((entry) => entry?.function?.name).filter(Boolean) ?? [],
      latestUserText: classification.latestUserText.slice(0, 4000),
      sawContinuationMarker: classification.sawContinuationMarker,
      toolResultNames: toolResultNames(messages),
      messageRoles: messages.map((message) => message?.role),
    })
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    const scenarioDef = SCENARIOS[scenario]
    if (classification.kind === "title") text(response, TITLE_TEXT)
    else if (classification.kind === "compaction") text(response, COMPACTED_SUMMARY)
    else if (classification.kind === "continuation") text(response, CONTINUATION_TEXT)
    else if (classification.kind === "tool" && call) toolCall(response, call.name, call.arguments)
    else if (classification.kind === "final" && scenarioDef?.finalDelayMs > 0) {
      setTimeout(() => text(response, scenarioDef.finalText ?? FALLBACK_TEXT), scenarioDef.finalDelayMs)
    } else text(response, scenarioDef?.finalText ?? FALLBACK_TEXT)
  })
}

function startedAsEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (startedAsEntrypoint() && process.env.RIGEL_FAKE_MODEL_IMPORT_ONLY !== "1") {
  createFixtureServer().listen(port, "127.0.0.1", () => {
    console.log(`Rigel todo-continuation fixture listening on ${port}`)
  })
}
