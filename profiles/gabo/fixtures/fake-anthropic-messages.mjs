import fs from "node:fs"
import http from "node:http"

// Deterministic Anthropic Messages API mock for the isolated lab: it records the
// FINAL request body the V2 Anthropic provider adapter produced, so reasoning
// transformations are observed rather than assumed. Non-streaming JSON and the
// SSE event sequence are both supported.
const port = Number(process.env.RIGEL_FAKE_MODEL_PORT ?? "41255")
const traceFile = process.env.RIGEL_FAKE_MODEL_TRACE
const reply = process.env.RIGEL_FAKE_ANTHROPIC_REPLY ?? "ANTHROPIC_FIXTURE_OK"
let requestCount = 0

function trace(value) {
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(value) + "\n")
}

function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function messageStart() {
  return {
    id: `msg_rigel_${requestCount}`,
    type: "message",
    role: "assistant",
    model: "rigel-anthropic-fixture",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  }
}

function respondStream(response) {
  sse(response, "message_start", { type: "message_start", message: messageStart() })
  sse(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  sse(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } })
  sse(response, "content_block_stop", { type: "content_block_stop", index: 0 })
  sse(response, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })
  sse(response, "message_stop", { type: "message_stop" })
  response.end()
}

function respondJson(response) {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({
    id: `msg_rigel_${requestCount}`,
    type: "message",
    role: "assistant",
    model: "rigel-anthropic-fixture",
    content: [{ type: "text", text: reply }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }))
}

http.createServer(async (request, response) => {
  const url = String(request.url ?? "")
  if (request.method !== "POST" || !url.includes("/messages")) {
    response.writeHead(404).end()
    return
  }
  let raw = ""
  for await (const chunk of request) raw += chunk
  let payload = {}
  try { payload = JSON.parse(raw || "{}") } catch { /* keep empty */ }
  requestCount += 1
  if (url.includes("count_tokens")) {
    trace({ requestCount, url, kind: "count_tokens" })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ input_tokens: 7 }))
    return
  }
  trace({
    requestCount,
    url,
    model: payload.model ?? null,
    stream: payload.stream ?? null,
    thinking: payload.thinking ?? null,
    output_config: payload.output_config ?? null,
    reasoning: payload.reasoning ?? null,
    reasoning_effort: payload.reasoning_effort ?? null,
    reasoningEffort: payload.reasoningEffort ?? null,
    max_tokens: payload.max_tokens ?? null,
    temperature: payload.temperature ?? null,
    keys: Object.keys(payload).sort(),
  })
  if (payload.stream === false) respondJson(response)
  else {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    respondStream(response)
  }
}).listen(port, "127.0.0.1", () => console.log(`Rigel anthropic messages fixture listening on ${port}`))
