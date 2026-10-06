import { expect, test } from "bun:test"
import {
  createNativeContextLimitRecovery,
  createNativeIdleContinuations,
  createNativeIdleGate,
} from "./rigel-v2-native-phase4-events.mjs"
import { createNativeCompactionIncidentRegistry } from "./rigel-v2-native-preemptive-compaction.mjs"

test("context-limit errors request exactly one V2 compaction until the incident closes", async () => {
  const compacted = []
  const recovery = createNativeContextLimitRecovery({ session: { compact: async (input) => { compacted.push(input) } }, log: () => {} })

  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "prompt is too long for this context length" } })
  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "prompt is too long for this context length" } })
  await recovery.handle({ type: "session.compacted", sessionID: "ses_1" })
  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "token limit reached" } })

  expect(compacted).toEqual([{ sessionID: "ses_1" }, { sessionID: "ses_1" }])
})

test("a shared incident registry collapses preemptive and reactive compaction requests", async () => {
  const registry = createNativeCompactionIncidentRegistry()
  const compacted = []
  const recovery = createNativeContextLimitRecovery({
    session: { compact: async (input) => { compacted.push(input) } },
    log: () => {},
    incident: registry,
  })

  // The preemptive trigger already holds the incident: the reactive recovery
  // must not admit a second compaction for the same session.
  registry.begin("ses_1")
  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "prompt is too long for this context length" } })
  expect(compacted).toEqual([])

  // Once the compaction lands the incident clears, so a fresh token-limit
  // incident is admitted again.
  await recovery.handle({ type: "session.compacted", sessionID: "ses_1" })
  await recovery.handle({ type: "session.error", sessionID: "ses_1", error: { message: "token limit reached" } })
  expect(compacted).toEqual([{ sessionID: "ses_1" }])
})

test("idle gate normalizes status idle and prevents duplicate continuation delivery", async () => {
  const times = [1000, 1100, 1600, 2200]
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
    { type: "session.execution.succeeded", data: { sessionID: "ses_3" } },
  ]) {
    const normalized = gate.accept(event)
    if (normalized) await continuation.handle(normalized)
  }

  expect(delivered).toHaveLength(3)
  expect(delivered[0]).toMatchObject({ sessionID: "ses_1" })
  expect(delivered[1]).toMatchObject({ sessionID: "ses_2" })
  expect(delivered[2]).toMatchObject({ sessionID: "ses_3" })
})
