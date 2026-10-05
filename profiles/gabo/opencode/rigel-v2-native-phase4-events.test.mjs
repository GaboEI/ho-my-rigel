import { expect, test } from "bun:test"
import {
  createNativeContextLimitRecovery,
  createNativeIdleContinuations,
  createNativeIdleGate,
} from "./rigel-v2-native-phase4-events.mjs"

test("context-limit errors request exactly one V2 compaction until the incident closes", async () => {
  const compacted = []
  const recovery = createNativeContextLimitRecovery({ session: { compact: async (input) => { compacted.push(input) } }, log: () => {} })

  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "prompt is too long for this context length" } })
  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "prompt is too long for this context length" } })
  await recovery.handle({ type: "session.compacted", sessionID: "ses_1" })
  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "token limit reached" } })

  expect(compacted).toEqual([{ sessionID: "ses_1" }, { sessionID: "ses_1" }])
})

test("idle gate normalizes status idle and prevents duplicate continuation delivery", async () => {
  const times = [1000, 1100, 1600]
  const gate = createNativeIdleGate({ now: () => times.shift() })
  const delivered = []
  const continuation = createNativeIdleContinuations({
    session: { synthetic: async (input) => { delivered.push(input) } },
    backgroundManager: { activeCount: () => 2 },
    resolveAgent: async () => "atlas",
  })

  for (const event of [
    { type: "session.status", properties: { sessionID: "ses_1", status: "idle" } },
    { type: "session.idle", properties: { sessionID: "ses_1" } },
    { type: "session.idle", properties: { sessionID: "ses_2" } },
  ]) {
    const normalized = gate.accept(event)
    if (normalized) await continuation.handle(normalized)
  }

  expect(delivered).toHaveLength(2)
  expect(delivered[0]).toMatchObject({ sessionID: "ses_1" })
  expect(delivered[1]).toMatchObject({ sessionID: "ses_2" })
})
