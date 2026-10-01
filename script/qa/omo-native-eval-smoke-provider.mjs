export function evalSmokeProviderSource() {
  return `
const model = { id: "gpt-5.6-sol", name: "Eval Smoke", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }
export default function register(pi) {
  pi.registerProvider("openai", { name: "Eval Smoke", baseUrl: "file://eval-smoke", apiKey: "mock", api: "openai-completions", models: [model], streamSimple(_model, context, options) { return stream(stepFor(context), options) } })
}
function stepFor(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : []
  const used = messages.some((message) => message?.role === "assistant" && Array.isArray(message.content) && message.content.some((item) => item?.type === "toolCall" && item.name === "eval"))
  return used
    ? { type: "text", text: "eval smoke complete" }
    : { type: "tool_call", name: "eval", arguments: { language: "js", code: "print(6 * 7)", summary: "Run release eval smoke" } }
}
function message(step, callCount) {
  const content = step.type === "text" ? [{ type: "text", text: step.text }] : [{ type: "toolCall", id: "eval-smoke-" + callCount, name: step.name, arguments: step.arguments }]
  return { role: "assistant", content, api: "openai-completions", provider: "openai", model: "gpt-5.6-sol", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: step.type === "tool_call" ? "toolUse" : "stop", timestamp: Date.now() }
}
let calls = 0
function stream(step, options) {
  const queue = []; const waiters = []; let done = false; let resolveResult; let rejectResult
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject }); result.catch(() => {})
  const output = { push(event) { if (done) return; const waiter = waiters.shift(); if (waiter) waiter({ value: event, done: false }); else queue.push(event) }, end(final) { if (done) return; done = true; resolveResult(final); while (waiters.length) waiters.shift()({ value: undefined, done: true }) }, fail(error) { if (done) return; done = true; rejectResult(error); while (waiters.length) waiters.shift()({ value: undefined, done: true }) }, result() { return result }, [Symbol.asyncIterator]() { return { next() { if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (done) return Promise.resolve({ value: undefined, done: true }); return new Promise((resolve) => waiters.push(resolve)) } } } }
  calls += 1; const final = message(step, calls)
  queueMicrotask(() => { if (options?.signal?.aborted) { output.end({ ...final, stopReason: "aborted" }); return } output.push({ type: "start", partial: { ...final, content: [] } }); if (step.type === "text") { output.push({ type: "text_start", contentIndex: 0, partial: { ...final, content: [{ type: "text", text: "" }] } }); output.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: final }); output.push({ type: "text_end", contentIndex: 0, content: step.text, partial: final }) } else { const toolCall = final.content[0]; output.push({ type: "toolcall_start", contentIndex: 0, partial: final }); output.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(step.arguments), partial: final }); output.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: final }) } output.push({ type: "done", reason: final.stopReason, message: final }); output.end(final) })
  return output
}
`
}
