import fs from "node:fs"
import http from "node:http"

const port = Number(process.env.RIGEL_FAKE_MODEL_PORT ?? "41234")
const traceFile = process.env.RIGEL_FAKE_MODEL_TRACE
const taskName = process.env.RIGEL_FAKE_TASK_NAME ?? "rigel_task"
const taskArguments = process.env.RIGEL_FAKE_TASK_ARGUMENTS ?? JSON.stringify({
  subagent_type: "explore",
  prompt: "Reply exactly SPECIALIST_EVIDENCE.",
  run_in_background: false,
})
const childMarker = process.env.RIGEL_FAKE_CHILD_MARKER ?? "<rigel-native-child-task>"
const childReply = process.env.RIGEL_FAKE_CHILD_REPLY ?? "SPECIALIST_EVIDENCE"
const parentReply = process.env.RIGEL_FAKE_PARENT_REPLY ?? "SELF_AUDIT_PASS"
let requestCount = 0
let delegationIssued = false

function trace(value) {
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(value) + "\n")
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function base() {
  return { id: `chatcmpl_rigel_${requestCount}`, object: "chat.completion.chunk", created: 0, model: "rigel-fixture" }
}

function text(response, content) {
  writeSse(response, { ...base(), choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })
  writeSse(response, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  response.end("data: [DONE]\n\n")
}

function task(response) {
  writeSse(response, {
    ...base(),
    choices: [{
      index: 0,
      delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_rigel_delegate", type: "function", function: { name: taskName, arguments: taskArguments } }] },
      finish_reason: null,
    }],
  })
  writeSse(response, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  response.end("data: [DONE]\n\n")
}

function compactedSummary(response) {
  text(response, `## Objective\n- Delegate research.\n\n## Requirements\n- (none)\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- (none)\n\n### Active\n- Delegate research.\n\n### Blocked\n- (none)\n\n## Next Move\n1. Delegate the research.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- (none)`)
}

http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end()
    return
  }
  let raw = ""
  for await (const chunk of request) raw += chunk
  const payload = JSON.parse(raw || "{}")
  requestCount += 1
  const hasTaskTool = Array.isArray(payload.tools) && payload.tools.some((entry) => entry?.function?.name === taskName)
  const hasToolResult = Array.isArray(payload.messages) && payload.messages.some((message) => message?.role === "tool")
  const systemText = payload.messages?.find((message) => message?.role === "system")?.content ?? ""
  const latestUserContent = [...(payload.messages ?? [])].reverse().find((message) => message?.role === "user")?.content ?? ""
  const latestUserText = typeof latestUserContent === "string" ? latestUserContent : JSON.stringify(latestUserContent)
  const responseKind = systemText.includes("You are a title generator")
    ? "title"
    : /^(You MUST summarize|Update the existing checkpoint|The previous response did not fill)/.test(latestUserText)
      ? "compaction"
      : latestUserText.includes(childMarker)
        ? "child"
        : hasTaskTool && !delegationIssued
          ? "delegate"
          : "complete"
  trace({
    requestCount,
    hasTaskTool,
    toolNames: payload.tools?.map((entry) => entry?.function?.name).filter(Boolean) ?? [],
    hasToolResult,
    responseKind,
    messageRoles: payload.messages?.map((message) => message?.role) ?? [],
    messages: payload.messages?.map((message) => ({
      role: message?.role,
      content: typeof message?.content === "string" ? message.content.slice(0, 5000) : "[structured]",
    })) ?? [],
  })
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  if (responseKind === "title") text(response, "Delegate research")
  else if (responseKind === "compaction") compactedSummary(response)
  else if (responseKind === "child") text(response, childReply)
  else if (responseKind === "delegate") {
    delegationIssued = true
    task(response)
  }
  else text(response, parentReply)
}).listen(port, "127.0.0.1", () => console.log(`Rigel native delegation fixture listening on ${port}`))
