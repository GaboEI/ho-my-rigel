import { describe, expect, test } from "bun:test"

import {
  MONITOR_STATUS_OPEN,
  MONITOR_STATUS_PREFIX,
  buildMonitorStatusBlock,
  createNativeMonitorStatusInjector,
  formatMonitorStatusLine,
  reconcileMonitorStatus,
  stripMonitorStatusBlocks,
} from "./rigel-v2-monitor-status.mjs"

const SEPARATOR = "\n\n---\n\n"

function record({ id, label, status, matchedLines, parentSessionId = "ses_orchestrator", command = "ignored raw command" }) {
  return { id, label, status, parentSessionId, command, counters: { matchedLines } }
}

// A registry that scopes `list` by parentSessionId exactly like the native
// engine, so isolation is a property of the real contract, not the fake.
function fakeRegistry(records) {
  return {
    async list(sessionID) {
      return records.filter((entry) => entry.parentSessionId === sessionID)
    },
  }
}

function injectorFor(records) {
  return createNativeMonitorStatusInjector({ getRegistry: () => fakeRegistry(records) })
}

function userMessage(sessionID, text = "continue") {
  return { role: "user", sessionID, content: text }
}

function contentOf(message) {
  return typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part?.text ?? "").join("")
}

function blockCount(message) {
  return (contentOf(message).match(new RegExp(MONITOR_STATUS_OPEN, "g")) ?? []).length
}

describe("native monitor status injector", () => {
  test("#given two active monitors #when the context hook runs #then one block carries every status and the stop hint", async () => {
    // given
    const injector = injectorFor([
      record({ id: "mon_ab12", label: "bun test", status: "running", matchedLines: 3, command: "bun test --token super-secret" }),
      record({ id: "mon_cd34", label: "tail -f", status: "starting", matchedLines: 0 }),
      record({ id: "mon_done", label: "ignored", status: "stopped", matchedLines: 8 }),
    ])
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator")] }

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(true)
    const [block] = contentOf(event.messages[0]).split(SEPARATOR)
    expect(block).toContain("mon_ab12")
    expect(block).toContain("bun test")
    expect(block).toContain("running")
    expect(block).toContain("3 matched")
    expect(block).toContain("mon_cd34")
    expect(block).toContain("starting")
    expect(block).toContain("monitor_stop")
    expect(block).not.toContain("mon_done")
    expect(block).not.toContain("super-secret")
    expect(block).not.toContain("--token")
  })

  test("#given no active monitors and no existing block #when the context hook runs #then the message list is unchanged", async () => {
    // given
    const injector = injectorFor([record({ id: "mon_stopped", label: "bun test", status: "stopped", matchedLines: 0 })])
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator")] }
    const before = structuredClone(event)

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(false)
    expect(event).toEqual(before)
  })

  test("#given the gate is off (no registry) #when an inherited block exists #then the injector is an absolute no-op", async () => {
    // given: the runtime does not build the injector when monitor.enabled is
    // false; the factory also refuses to touch anything without a registry.
    const injector = createNativeMonitorStatusInjector({ getRegistry: () => undefined })
    const stale = `${buildMonitorStatusBlock([record({ id: "mon_x", label: "x", status: "running", matchedLines: 1 })])}${SEPARATOR}continue`
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator", stale)] }
    const before = structuredClone(event)

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(false)
    expect(event).toEqual(before)
  })

  test("#given an active monitor #when the context hook runs twice #then exactly one block exists", async () => {
    // given
    const injector = injectorFor([record({ id: "mon_once", label: "bun test", status: "running", matchedLines: 4 })])
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator")] }

    // when
    await injector(event)
    await injector(event)

    // then
    expect(blockCount(event.messages[0])).toBe(1)
    expect(event.messages).toHaveLength(1)
  })

  test("#given the only monitor stopped #when the context hook runs again on the same array #then the block is removed and the text restored exactly", async () => {
    // given a session that injected a block for one active monitor
    let records = [record({ id: "mon_live", label: "bun test", status: "running", matchedLines: 3 })]
    const injector = createNativeMonitorStatusInjector({ getRegistry: () => fakeRegistry(records) })
    const original = "please continue\n\n---\n\nwith the plan"
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator", original)] }
    await injector(event)
    expect(blockCount(event.messages[0])).toBe(1)
    expect(contentOf(event.messages[0])).toContain("mon_live")

    // when the monitor exits and the hook runs again
    records = [record({ id: "mon_live", label: "bun test", status: "exited", matchedLines: 3 })]
    const mutated = await injector(event)

    // then the block is gone and the original text is byte-for-byte identical
    expect(mutated).toBe(true)
    expect(blockCount(event.messages[0])).toBe(0)
    expect(contentOf(event.messages[0])).toBe(original)
  })

  test("#given the active set shrinks #when the context hook runs again #then the block refreshes to the remaining monitor", async () => {
    // given two active monitors
    let records = [
      record({ id: "mon_a", label: "a", status: "running", matchedLines: 1 }),
      record({ id: "mon_b", label: "b", status: "running", matchedLines: 2 }),
    ]
    const injector = createNativeMonitorStatusInjector({ getRegistry: () => fakeRegistry(records) })
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator")] }
    await injector(event)
    expect(contentOf(event.messages[0])).toContain("mon_a")
    expect(contentOf(event.messages[0])).toContain("mon_b")

    // when one monitor stops
    records = [
      record({ id: "mon_a", label: "a", status: "stopped", matchedLines: 1 }),
      record({ id: "mon_b", label: "b", status: "running", matchedLines: 9 }),
    ]
    await injector(event)

    // then exactly one block, listing only the remaining monitor with fresh counters
    expect(blockCount(event.messages[0])).toBe(1)
    expect(contentOf(event.messages[0])).toContain("mon_b")
    expect(contentOf(event.messages[0])).not.toContain("mon_a")
    expect(contentOf(event.messages[0])).toContain("9 matched")
  })

  test("#given several inherited blocks #when an active monitor is present #then exactly one fresh block remains", async () => {
    // given a text with two duplicated blocks
    const block = buildMonitorStatusBlock([record({ id: "mon_old", label: "old", status: "running", matchedLines: 1 })])
    const inherited = `${block}${SEPARATOR}${block}${SEPARATOR}keep this text`
    const injector = injectorFor([record({ id: "mon_new", label: "new", status: "running", matchedLines: 2 })])
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator", inherited)] }

    // when
    await injector(event)

    // then
    expect(blockCount(event.messages[0])).toBe(1)
    expect(contentOf(event.messages[0])).toContain("mon_new")
    expect(contentOf(event.messages[0])).not.toContain("mon_old")
    expect(contentOf(event.messages[0])).toContain("keep this text")
  })

  test("#given several inherited malformed blocks #when there are zero active monitors #then all are removed and the text kept", async () => {
    // given a well-formed block plus a dangling open tag with no close
    const block = buildMonitorStatusBlock([record({ id: "mon_old", label: "old", status: "running", matchedLines: 1 })])
    const inherited = `${block}${SEPARATOR}${MONITOR_STATUS_OPEN}\nActive monitors: dangling - call monitor_stop to stop${SEPARATOR}surviving text`
    const injector = injectorFor([])
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator", inherited)] }

    // when
    await injector(event)

    // then
    expect(contentOf(event.messages[0])).not.toContain(MONITOR_STATUS_OPEN)
    expect(contentOf(event.messages[0])).toBe("surviving text")
  })

  test("#given monitors owned by another session #when that session's turn runs #then no monitor leaks across sessions", async () => {
    // given
    const injector = injectorFor([record({ id: "mon_other", label: "other session", status: "running", matchedLines: 7, parentSessionId: "ses_other" })])
    const event = { sessionID: "ses_orchestrator", messages: [userMessage("ses_orchestrator")] }
    const before = structuredClone(event)

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(false)
    expect(event).toEqual(before)
  })

  test("#given an array content message #when a monitor is active then stops #then the text part is injected and restored", async () => {
    // given
    let records = [record({ id: "mon_parts", label: "parts", status: "running", matchedLines: 2 })]
    const injector = createNativeMonitorStatusInjector({ getRegistry: () => fakeRegistry(records) })
    const event = { sessionID: "ses_orchestrator", messages: [{ role: "user", sessionID: "ses_orchestrator", content: [{ type: "text", text: "continue" }] }] }

    // when active
    await injector(event)
    expect(event.messages[0].content[0].text).toContain(MONITOR_STATUS_PREFIX)
    expect(event.messages[0].content[0].text).toContain("mon_parts")

    // when zero active
    records = []
    await injector(event)

    // then
    expect(event.messages[0].content[0].text).toBe("continue")
  })

  test("#given no real user message #when the hook runs #then a stale block is stripped but no turn is fabricated", async () => {
    // given: only an assistant message carries the inherited block
    const block = buildMonitorStatusBlock([record({ id: "mon_x", label: "watcher", status: "running", matchedLines: 1 })])
    const injector = injectorFor([])
    const event = { sessionID: "ses_orchestrator", messages: [{ role: "assistant", content: `${block}${SEPARATOR}answer` }] }

    // when
    const mutated = await injector(event)

    // then
    expect(mutated).toBe(true)
    expect(event.messages).toHaveLength(1)
    expect(contentOf(event.messages[0])).toBe("answer")
  })

  test("#given a block-bearing text #when stripping directly #then duplicates and dangling tags are removed exactly", () => {
    // given
    const block = buildMonitorStatusBlock([record({ id: "mon_a", label: "a", status: "running", matchedLines: 1 })])
    const input = `${block}${SEPARATOR}${block}${SEPARATOR}tail`
    const dangling = `${MONITOR_STATUS_OPEN}\nunfinished${SEPARATOR}body`

    // when / then
    expect(stripMonitorStatusBlocks(input)).toEqual({ text: "tail", removed: true })
    expect(stripMonitorStatusBlocks(dangling)).toEqual({ text: "body", removed: true })
    expect(stripMonitorStatusBlocks("clean text")).toEqual({ text: "clean text", removed: false })
    expect(formatMonitorStatusLine([record({ id: "mon_a", label: "a", status: "running", matchedLines: 5 })])).toContain("5 matched")
  })

  test("#given a block already present #when reconciling to a new block directly #then it is replaced and de-duplicated", () => {
    // given
    const oldBlock = buildMonitorStatusBlock([record({ id: "mon_a", label: "a", status: "running", matchedLines: 1 })])
    const newBlock = buildMonitorStatusBlock([record({ id: "mon_a", label: "a", status: "running", matchedLines: 5 })])
    const event = { messages: [{ role: "user", content: `${oldBlock}${SEPARATOR}continue` }] }

    // when
    const mutated = reconcileMonitorStatus(event, newBlock)

    // then
    expect(mutated).toBe(true)
    expect(blockCount(event.messages[0])).toBe(1)
    expect(contentOf(event.messages[0])).toContain("5 matched")
    expect(contentOf(event.messages[0])).not.toContain("1 matched")
    expect(contentOf(event.messages[0])).toContain("continue")
  })
})
