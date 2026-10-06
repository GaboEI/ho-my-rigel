import { describe, expect, test } from "bun:test"

process.env.RIGEL_FAKE_MODEL_IMPORT_ONLY = "1"
const fixture = await import("./fake-openai-todo-continuation.mjs")
delete process.env.RIGEL_FAKE_MODEL_IMPORT_ONLY
const { scenarioFromMessages, correlationFromMessages, classifyRequest, nextToolCall, createFixtureServer } = fixture

const CONTINUATION_MARKER = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]"

function user(text) {
  return { role: "user", content: text }
}

function assistantCalls(calls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  }
}

function toolResult(name, content) {
  return { role: "tool", tool_call_id: "call_0", name, content: typeof content === "string" ? content : JSON.stringify(content) }
}

function scenarioMessages(scenario, sessionID, calls = []) {
  const messages = [user(`[[T22:${scenario}]] session_id: ${sessionID}`)]
  for (const call of calls) {
    messages.push(assistantCalls([{ name: call.name, arguments: call.arguments }]))
    messages.push(toolResult(call.name, call.result ?? "{}"))
  }
  return messages
}

function parseSse(raw) {
  const toolCalls = []
  const finishReasons = []
  let content = ""
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6)
    if (data === "[DONE]") continue
    const choice = JSON.parse(data)?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === "string") content += delta.content
    for (const call of delta.tool_calls ?? []) {
      toolCalls.push({ name: call?.function?.name, arguments: call?.function?.arguments })
    }
    if (choice.finish_reason) finishReasons.push(choice.finish_reason)
  }
  return { toolCalls, content, finishReasons }
}

async function withServer(run) {
  const server = createFixtureServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address()
  try {
    return await run({ url: `http://127.0.0.1:${port}/v1/chat/completions` })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function callFixture(url, messages, tools = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "rigel-fixture", messages, tools, stream: true }),
  })
  return parseSse(await response.text())
}

describe("fake-openai-todo-continuation: scenarioFromMessages", () => {
  test("#given a user message with a scenario sentinel #when scanning #then the scenario is returned", () => {
    expect(scenarioFromMessages([user("run [[T22:storage-write]] now")])).toBe("storage-write")
  })

  test("#given the sentinel only in older history #when scanning #then it persists", () => {
    const messages = [
      user("[[T22:task-mirror]] session_id: ses_t22"),
      assistantCalls([{ name: "task_create", arguments: "{}" }]),
      toolResult("task_create", "{}"),
      user("keep going"),
    ]
    expect(scenarioFromMessages(messages)).toBe("task-mirror")
  })

  test("#given no sentinel #when scanning #then null", () => {
    expect(scenarioFromMessages([user("hello there")])).toBeNull()
  })

  test("#given the sentinel inside V2 text parts #when scanning #then it is found", () => {
    expect(scenarioFromMessages([{ role: "user", content: [{ type: "text", text: "[[T22:compaction]]" }] }])).toBe("compaction")
  })
})

describe("fake-openai-todo-continuation: classifyRequest", () => {
  test("#given a title-generator system message #when classifying #then kind is title", () => {
    const messages = [{ role: "system", content: "You are a title generator" }, user("anything")]
    expect(classifyRequest(messages, null).kind).toBe("title")
  })

  test("#given a summarization directive #when classifying #then kind is compaction", () => {
    expect(classifyRequest([user("You MUST summarize the conversation")], null).kind).toBe("compaction")
  })

  test("#given a continuation directive #when classifying #then kind is continuation and the marker is recorded", () => {
    const messages = [user(`[[T22:continuation]] ${CONTINUATION_MARKER}\nIncomplete tasks remain`)]
    const result = classifyRequest(messages, "continuation")
    expect(result.kind).toBe("continuation")
    expect(result.sawContinuationMarker).toBe(true)
  })

  test("#given a fresh scenario request #when classifying #then kind is tool", () => {
    expect(classifyRequest([user("[[T22:storage-write]]")], "storage-write").kind).toBe("tool")
  })

  test("#given every scenario tool turn answered #when classifying #then kind is final", () => {
    const messages = scenarioMessages("storage-write", "ses_t22", [
      { name: "todowrite", arguments: "{}" },
      { name: "session_read", arguments: "{}" },
    ])
    expect(classifyRequest(messages, "storage-write").kind).toBe("final")
  })
})

describe("fake-openai-todo-continuation: correlationFromMessages", () => {
  test("#given a seed prompt with a correlation token #when scanning #then the token is returned", () => {
    expect(correlationFromMessages([user("[[T22:continuation]] RIGEL-CORR:e5-cooldown-42 Seed")])).toBe("e5-cooldown-42")
  })

  test("#given the token only in older history #when scanning #then it persists for every later request", () => {
    const messages = [
      user("[[T22:continuation]] RIGEL-CORR:e5-abort-7 Seed"),
      assistantCalls([{ name: "todowrite", arguments: "{}" }]),
      toolResult("todowrite", "{}"),
      user("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION] continue"),
    ]
    expect(correlationFromMessages(messages)).toBe("e5-abort-7")
  })

  test("#given no token #when scanning #then null", () => {
    expect(correlationFromMessages([user("plain prompt")])).toBeNull()
  })
})

describe("fake-openai-todo-continuation: nextToolCall", () => {
  test("#given storage-write with no tool result #when resolving #then todowrite carries the two todos", () => {
    const call = nextToolCall(scenarioMessages("storage-write", "ses_t22"), "storage-write")
    expect(call).toEqual({
      name: "todowrite",
      arguments:
        '{"todos":[{"id":"store-a","content":"Storage todo A","status":"pending","priority":"high"},{"id":"store-b","content":"Storage todo B","status":"in_progress","priority":"medium"}]}',
    })
  })

  test("#given storage-write with one tool result #when resolving #then session_read uses the request session id", () => {
    const messages = scenarioMessages("storage-write", "ses_t22", [{ name: "todowrite", arguments: "{}" }])
    expect(nextToolCall(messages, "storage-write")).toEqual({
      name: "session_read",
      arguments: '{"session_id":"ses_t22","include_todos":true}',
    })
  })

  test("#given task-mirror turns #when resolving each #then the tool sequence is exact", () => {
    const first = nextToolCall(scenarioMessages("task-mirror", "ses_t22"), "task-mirror")
    expect(first).toEqual({ name: "task_create", arguments: '{"subject":"Unrelated todo must persist","status":"pending"}' })

    const afterUnrelated = [{ name: "task_create", arguments: first.arguments, result: { task: { id: "T-UNRELATED" } } }]
    const second = nextToolCall(scenarioMessages("task-mirror", "ses_t22", afterUnrelated), "task-mirror")
    expect(second).toEqual({ name: "task_create", arguments: '{"subject":"Mirror task","status":"pending"}' })

    const afterCreate = [...afterUnrelated, { name: "task_create", arguments: second.arguments, result: { task: { id: "T-42" } } }]
    const third = nextToolCall(scenarioMessages("task-mirror", "ses_t22", afterCreate), "task-mirror")
    expect(third).toEqual({ name: "task_update", arguments: '{"id":"T-42","status":"completed"}' })

    const afterUpdate = [...afterCreate, { name: "task_update", arguments: third.arguments }]
    const fourth = nextToolCall(scenarioMessages("task-mirror", "ses_t22", afterUpdate), "task-mirror")
    expect(fourth).toEqual({ name: "session_read", arguments: '{"session_id":"ses_t22","include_todos":true}' })

    const afterRead = [...afterUpdate, { name: "session_read", arguments: fourth.arguments }]
    const fifth = nextToolCall(scenarioMessages("task-mirror", "ses_t22", afterRead), "task-mirror")
    expect(fifth).toEqual({ name: "session_info", arguments: '{"session_id":"ses_t22"}' })

    const afterInfo = [...afterRead, { name: "session_info", arguments: fifth.arguments }]
    expect(nextToolCall(scenarioMessages("task-mirror", "ses_t22", afterInfo), "task-mirror")).toBeNull()
  })

  test("#given each single-turn scenario #when resolving the first turn #then the exact tool call is emitted", () => {
    expect(nextToolCall(scenarioMessages("compaction", "ses_t22"), "compaction")).toEqual({
      name: "todowrite",
      arguments: '{"todos":[{"id":"detailed-1","content":"Detailed work item","status":"in_progress","priority":"high"}]}',
    })
    expect(nextToolCall(scenarioMessages("compaction-late", "ses_t22"), "compaction-late")).toEqual({
      name: "todowrite",
      arguments:
        '{"todos":[{"id":"orchestrate-plan","content":"Complete ALL implementation tasks","status":"pending","priority":"medium"},{"id":"pass-final-wave","content":"Pass Final Verification Wave - ALL reviewers APPROVE","status":"pending","priority":"medium"}]}',
    })
    expect(nextToolCall(scenarioMessages("continuation", "ses_t22"), "continuation")).toEqual({
      name: "todowrite",
      arguments: '{"todos":[{"id":"c-1","content":"Continue me","status":"pending","priority":"medium"}]}',
    })
    expect(nextToolCall(scenarioMessages("continuation-complete", "ses_t22"), "continuation-complete")).toEqual({
      name: "todowrite",
      arguments: '{"todos":[{"id":"c-done","content":"Already done","status":"completed","priority":"medium"}]}',
    })
    expect(nextToolCall(scenarioMessages("idle-only", "ses_t22"), "idle-only")).toBeNull()
  })

  test("#given question-pending #when resolving each turn #then todowrite precedes an open question tool call", () => {
    const first = nextToolCall(scenarioMessages("question-pending", "ses_t22"), "question-pending")
    expect(first).toEqual({
      name: "todowrite",
      arguments: '{"todos":[{"id":"qp-1","content":"Question-blocked work","status":"in_progress","priority":"high"}]}',
    })

    const afterSeed = scenarioMessages("question-pending", "ses_t22", [{ name: "todowrite", arguments: first.arguments }])
    const second = nextToolCall(afterSeed, "question-pending")
    expect(second.name).toBe("question")
    const parsed = JSON.parse(second.arguments)
    expect(parsed.questions[0].question).toBe("Proceed with the blocked work?")
    expect(parsed.questions[0].options.map((option) => option.label)).toEqual(["Yes", "No"])
    expect(parsed.questions[0].multiple).toBe(false)

    const afterQuestion = scenarioMessages("question-pending", "ses_t22", [
      { name: "todowrite", arguments: first.arguments },
      { name: "question", arguments: second.arguments },
    ])
    expect(nextToolCall(afterQuestion, "question-pending")).toBeNull()
  })

  test("#given continuation-slow #when resolving each turn #then the seed is one todowrite and then the final text", () => {
    const first = nextToolCall(scenarioMessages("continuation-slow", "ses_t22"), "continuation-slow")
    expect(first).toEqual({
      name: "todowrite",
      arguments: '{"todos":[{"id":"slow-1","content":"Interrupted work","status":"in_progress","priority":"high"}]}',
    })
    const afterSeed = scenarioMessages("continuation-slow", "ses_t22", [{ name: "todowrite", arguments: first.arguments }])
    expect(nextToolCall(afterSeed, "continuation-slow")).toBeNull()
    expect(classifyRequest(afterSeed, "continuation-slow").kind).toBe("final")
  })

  test("#given a tool name override #when resolving #then the emitted function name is overridden", () => {
    const call = nextToolCall(scenarioMessages("storage-write", "ses_t22"), "storage-write", { toolName: "custom_tool" })
    expect(call.name).toBe("custom_tool")
  })
})

describe("fake-openai-todo-continuation: SSE output", () => {
  test("#given storage-write #when driven over SSE #then it emits todowrite, session_read, then the done text", async () => {
    await withServer(async ({ url }) => {
      const first = await callFixture(url, scenarioMessages("storage-write", "ses_t22"))
      expect(first.toolCalls).toEqual([
        {
          name: "todowrite",
          arguments:
            '{"todos":[{"id":"store-a","content":"Storage todo A","status":"pending","priority":"high"},{"id":"store-b","content":"Storage todo B","status":"in_progress","priority":"medium"}]}',
        },
      ])
      expect(first.finishReasons).toContain("tool_calls")

      const second = await callFixture(
        url,
        scenarioMessages("storage-write", "ses_t22", [{ name: "todowrite", arguments: first.toolCalls[0].arguments }]),
      )
      expect(second.toolCalls).toEqual([{ name: "session_read", arguments: '{"session_id":"ses_t22","include_todos":true}' }])

      const third = await callFixture(
        url,
        scenarioMessages("storage-write", "ses_t22", [
          { name: "todowrite", arguments: first.toolCalls[0].arguments },
          { name: "session_read", arguments: second.toolCalls[0].arguments },
        ]),
      )
      expect(third.toolCalls).toEqual([])
      expect(third.content).toBe("STORAGE_WRITE_DONE")
      expect(third.finishReasons).toContain("stop")
    })
  })

  test("#given task-mirror #when driven over SSE #then the six turns are exact", async () => {
    await withServer(async ({ url }) => {
      const expected = [
        { name: "task_create", arguments: '{"subject":"Unrelated todo must persist","status":"pending"}' },
        { name: "task_create", arguments: '{"subject":"Mirror task","status":"pending"}' },
        { name: "task_update", arguments: '{"id":"T-42","status":"completed"}' },
        { name: "session_read", arguments: '{"session_id":"ses_t22","include_todos":true}' },
        { name: "session_info", arguments: '{"session_id":"ses_t22"}' },
      ]
      const calls = []
      for (let index = 0; index < expected.length; index += 1) {
        const turn = await callFixture(url, scenarioMessages("task-mirror", "ses_t22", calls))
        expect(turn.toolCalls).toEqual([expected[index]])
        calls.push({
          name: turn.toolCalls[0].name,
          arguments: turn.toolCalls[0].arguments,
          result: index === 0 ? { task: { id: "T-UNRELATED" } } : index === 1 ? { task: { id: "T-42" } } : "{}",
        })
      }
      const final = await callFixture(url, scenarioMessages("task-mirror", "ses_t22", calls))
      expect(final.toolCalls).toEqual([])
      expect(final.content).toBe("TASK_MIRROR_DONE")
    })
  })

  test("#given each single-turn scenario #when driven over SSE #then the first tool call is exact", async () => {
    await withServer(async ({ url }) => {
      const cases = [
        [
          "compaction",
          { name: "todowrite", arguments: '{"todos":[{"id":"detailed-1","content":"Detailed work item","status":"in_progress","priority":"high"}]}' },
        ],
        [
          "compaction-late",
          {
            name: "todowrite",
            arguments:
              '{"todos":[{"id":"orchestrate-plan","content":"Complete ALL implementation tasks","status":"pending","priority":"medium"},{"id":"pass-final-wave","content":"Pass Final Verification Wave - ALL reviewers APPROVE","status":"pending","priority":"medium"}]}',
          },
        ],
        [
          "continuation",
          { name: "todowrite", arguments: '{"todos":[{"id":"c-1","content":"Continue me","status":"pending","priority":"medium"}]}' },
        ],
        [
          "continuation-complete",
          { name: "todowrite", arguments: '{"todos":[{"id":"c-done","content":"Already done","status":"completed","priority":"medium"}]}' },
        ],
      ]
      for (const [scenario, expected] of cases) {
        const turn = await callFixture(url, scenarioMessages(scenario, "ses_t22"))
        expect(turn.toolCalls).toEqual([expected])
      }
    })
  })

  test("#given a title-generator request #when driven over SSE #then a short title is returned", async () => {
    await withServer(async ({ url }) => {
      const turn = await callFixture(url, [{ role: "system", content: "You are a title generator" }, user("summarize this")])
      expect(turn.toolCalls).toEqual([])
      expect(turn.content).toBe("T22 todo continuity")
    })
  })

  test("#given idle-only #when driven over SSE #then no tool call and the done text", async () => {
    await withServer(async ({ url }) => {
      const turn = await callFixture(url, scenarioMessages("idle-only", "ses_t22"))
      expect(turn.toolCalls).toEqual([])
      expect(turn.content).toBe("IDLE_ONLY_DONE")
    })
  })

  test("#given question-pending #when driven over SSE #then todowrite then the open question tool call", async () => {
    await withServer(async ({ url }) => {
      const first = await callFixture(url, scenarioMessages("question-pending", "ses_t22"))
      expect(first.toolCalls[0].name).toBe("todowrite")
      const second = await callFixture(
        url,
        scenarioMessages("question-pending", "ses_t22", [{ name: "todowrite", arguments: first.toolCalls[0].arguments }]),
      )
      expect(second.toolCalls[0].name).toBe("question")
      expect(JSON.parse(second.toolCalls[0].arguments).questions[0].header).toBe("Proceed?")
    })
  })

  test("#given a summarization request #when driven over SSE #then the eight-section summary is returned", async () => {
    await withServer(async ({ url }) => {
      const turn = await callFixture(url, [user("You MUST summarize the conversation")])
      expect(turn.toolCalls).toEqual([])
      expect(turn.content).toContain("## Objective")
      expect(turn.content).toContain("## Next Move")
      expect(turn.content).toContain("## Important Context")
    })
  })

  test("#given a continuation directive #when driven over SSE #then plain text is returned with no tool call", async () => {
    await withServer(async ({ url }) => {
      const turn = await callFixture(url, [user(`[[T22:continuation]] ${CONTINUATION_MARKER}\nIncomplete tasks remain`)])
      expect(turn.toolCalls).toEqual([])
      expect(turn.content).toBe("CONTINUATION_ACK")
    })
  })
})
