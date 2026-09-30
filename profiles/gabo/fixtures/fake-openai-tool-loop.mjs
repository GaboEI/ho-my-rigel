import http from "node:http"

const port = Number(process.env.RIGEL_FAKE_MODEL_PORT ?? "4010")
let requestCount = 0

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function completionBase() {
  return { id: `chatcmpl_rigel_${requestCount}`, object: "chat.completion.chunk", created: 0, model: "rigel-fixture" }
}

function textResponse(response, content) {
  writeSse(response, { ...completionBase(), choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })
  writeSse(response, { ...completionBase(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  response.end("data: [DONE]\n\n")
}

function taskResponse(response) {
  const argumentsJson = JSON.stringify({
    description: "Isolated Rigel delegation evidence",
    prompt: "Return exactly SPECIALIST_EVIDENCE after inspecting the delegated contract.",
    subagent_type: "explore",
    run_in_background: false,
    load_skills: [],
  })
  writeSse(response, {
    ...completionBase(),
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_rigel_delegate", type: "function", function: { name: "task", arguments: argumentsJson } }],
      },
      finish_reason: null,
    }],
  })
  writeSse(response, { ...completionBase(), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  response.end("data: [DONE]\n\n")
}

http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end()
    return
  }
  let body = ""
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body || "{}")
  requestCount += 1
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  const hasTaskTool = Array.isArray(payload.tools) && payload.tools.some((tool) => tool?.function?.name === "task")
  const hasToolResult = Array.isArray(payload.messages) && payload.messages.some((message) => message?.role === "tool")
  if (hasTaskTool && !hasToolResult) taskResponse(response)
  else if (hasToolResult) textResponse(response, "SELF_AUDIT_PASS")
  else textResponse(response, "SPECIALIST_EVIDENCE")
}).listen(port, "127.0.0.1", () => console.log(`Rigel fake OpenAI provider listening on ${port}`))
