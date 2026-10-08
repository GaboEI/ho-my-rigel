/**
 * Unit contract for the pure BTW side-conversation core.
 *
 * Pins the V1-ported invariants: metadata key/version, the parent-context byte
 * and message caps, the controller state machine (retained sides, tombstones,
 * escape-return), and the picker option/selection mapping.
 */
import { describe, expect, test } from "bun:test"

import {
  BTW_BOUNDARY_SENTINEL,
  BTW_PARENT_CONTEXT_MAX_BYTES,
  BTW_PARENT_CONTEXT_MAX_MESSAGES,
  BTW_PICKER_NEW_PREFIX,
  BTW_PICKER_SESSION_PREFIX,
  BTW_SIDE_METADATA_KEY,
  BTW_SIDE_METADATA_VERSION,
  MAX_DELETED_SESSION_TOMBSTONES,
  btwMessageText,
  boundBtwParentContext,
  buildBtwPickerOptions,
  buildBtwBoundaryText,
  candidateParentSessions,
  classifyBtwSessionCatalog,
  createBtwController,
  createBtwEscapeReturn,
  createBtwPromptQueue,
  createBtwSideMetadata,
  findBtwBoundaryMessageID,
  getBtwSideMetadata,
  isBtwCommandDraft,
  messageContainsBtwBoundary,
  parseBtwPickerValue,
  parseBtwQuestion,
  parseBtwSideMetadata,
  prepareBtwSideStart,
  serializedMessageBytes,
} from "./rigel-v2-btw-core.mjs"

function textMessage(text, role = "user", id) {
  return { role, content: [{ type: "text", text }], ...(id ? { id } : {}) }
}

describe("#given BTW side metadata", () => {
  test("#then the key and version match the V1 owner exactly", () => {
    expect(BTW_SIDE_METADATA_KEY).toBe("omo_btw_side")
    expect(BTW_SIDE_METADATA_VERSION).toBe(1)
  })

  test("#when created and read back #then parent + boundary survive and version is pinned", () => {
    // given
    const metadata = createBtwSideMetadata({ parentSessionID: "ses_main", boundaryMessageID: "msg_9" })

    // then
    expect(metadata).toEqual({ version: 1, parent_session_id: "ses_main", boundary_message_id: "msg_9" })
    expect(parseBtwSideMetadata(metadata)).toEqual(metadata)
    expect(getBtwSideMetadata({ metadata: { [BTW_SIDE_METADATA_KEY]: metadata } })).toEqual(metadata)
  })

  test("#when the version or a field is wrong #then parsing rejects it", () => {
    // when / then
    expect(parseBtwSideMetadata({ version: 2, parent_session_id: "a", boundary_message_id: "b" })).toBeUndefined()
    expect(parseBtwSideMetadata({ version: 1, parent_session_id: "", boundary_message_id: "b" })).toBeUndefined()
    expect(parseBtwSideMetadata({ version: 1, parent_session_id: "a" })).toBeUndefined()
    expect(parseBtwSideMetadata(null)).toBeUndefined()
    expect(getBtwSideMetadata({ metadata: {} })).toBeUndefined()
    expect(getBtwSideMetadata(undefined)).toBeUndefined()
  })
})

describe("#given the parent-context budget", () => {
  test("#then the caps match the V1 owner exactly", () => {
    expect(BTW_PARENT_CONTEXT_MAX_BYTES).toBe(64 * 1024)
    expect(BTW_PARENT_CONTEXT_MAX_MESSAGES).toBe(64)
  })

  test("#when more than 64 messages arrive #then only the most recent 64 survive", () => {
    // given
    const messages = Array.from({ length: 100 }, (_, index) => textMessage(`m${index}`, "user", `msg_${index}`))

    // when
    const bounded = boundBtwParentContext(messages)

    // then
    expect(bounded).toHaveLength(BTW_PARENT_CONTEXT_MAX_MESSAGES)
    expect(btwMessageText(bounded[0])).toBe("m36")
    expect(btwMessageText(bounded.at(-1))).toBe("m99")
    expect(serializedMessageBytes(bounded)).toBeLessThanOrEqual(BTW_PARENT_CONTEXT_MAX_BYTES)
  })

  test("#when the transcript exceeds the byte cap #then older messages are dropped under the cap", () => {
    // given: each ~4KB, 40 of them = ~160KB
    const messages = Array.from({ length: 40 }, (_, index) =>
      textMessage(`${index}:`.padEnd(4000, "x"), "user", `msg_${index}`),
    )

    // when
    const bounded = boundBtwParentContext(messages)

    // then
    expect(bounded.length).toBeGreaterThan(0)
    expect(bounded.length).toBeLessThan(messages.length)
    expect(serializedMessageBytes(bounded)).toBeLessThanOrEqual(BTW_PARENT_CONTEXT_MAX_BYTES)
    expect(btwMessageText(bounded.at(-1)).startsWith("39:")).toBe(true)
  })

  test("#when a single message alone exceeds the cap #then it is truncated to fit", () => {
    // given
    const huge = textMessage("z".repeat(200_000), "user", "msg_huge")

    // when
    const bounded = boundBtwParentContext([huge])

    // then
    expect(bounded).toHaveLength(1)
    expect(serializedMessageBytes(bounded)).toBeLessThanOrEqual(BTW_PARENT_CONTEXT_MAX_BYTES)
    expect(btwMessageText(bounded[0])).toContain("[Earlier parent message content truncated]")
  })

  test("#when the input is bounded twice #then the result is deterministic and the input is untouched", () => {
    // given
    const messages = [textMessage("a", "user", "msg_1"), textMessage("b", "assistant", "msg_2")]
    const snapshot = JSON.parse(JSON.stringify(messages))

    // when
    const first = boundBtwParentContext(messages)
    const second = boundBtwParentContext(messages)

    // then
    expect(first).toEqual(second)
    expect(messages).toEqual(snapshot)
  })
})

describe("#given the BTW boundary marker", () => {
  test("#then the sentinel is the V1 value and detection is content-shape aware", () => {
    expect(BTW_BOUNDARY_SENTINEL).toBe("<omo-btw-boundary>")
    expect(buildBtwBoundaryText("ses_main")).toContain(BTW_BOUNDARY_SENTINEL)
    expect(buildBtwBoundaryText("ses_main")).toContain("ses_main")
    expect(messageContainsBtwBoundary(textMessage(`${BTW_BOUNDARY_SENTINEL}\nrest`))).toBe(true)
    expect(messageContainsBtwBoundary({ role: "user", content: "plain" })).toBe(false)
    expect(messageContainsBtwBoundary({ role: "user", content: [{ type: "text", text: BTW_BOUNDARY_SENTINEL }] })).toBe(true)
  })
})

describe("#given the command draft helpers", () => {
  test("#when a /btw draft is parsed #then the question is extracted and the draft is consumed", () => {
    expect(isBtwCommandDraft("/btw what is X")).toBe(true)
    expect(isBtwCommandDraft("/side more")).toBe(true)
    expect(isBtwCommandDraft("btw not a command")).toBe(false)
    expect(parseBtwQuestion("/btw what is X")).toEqual({ consumeDraft: true, question: "what is X" })
    expect(parseBtwQuestion("/btw")).toEqual({ consumeDraft: true, question: "" })
    expect(parseBtwQuestion("hello")).toEqual({ consumeDraft: false, question: "" })
  })

  test("#when picking a boundary #then the most recent user-or-completed message wins", () => {
    expect(
      findBtwBoundaryMessageID([
        { info: { id: "m1", role: "assistant", time: { completed: 1 } } },
        { info: { id: "m2", role: "user" } },
        { info: { id: "m3", role: "assistant", time: { completed: 2 } } },
      ]),
    ).toBe("m3")
    expect(
      findBtwBoundaryMessageID([{ info: { id: "m1", role: "user" } }]),
    ).toBe("m1")
    expect(
      findBtwBoundaryMessageID([{ info: { id: "m1", role: "assistant", time: { completed: 1 } } }]),
    ).toBe("m1")
    expect(findBtwBoundaryMessageID([])).toBeUndefined()
    // V2 lean shape
    expect(findBtwBoundaryMessageID([{ id: "v2", role: "user" }])).toBe("v2")
  })
})

function controllerHarness() {
  const created = []
  const navigated = []
  const toasts = []
  const deleted = []
  const deps = {
    currentSessionID: "ses_main",
    sessions: { ses_main: { id: "ses_main", title: "Main", agent: "sisyphus", model: { providerID: "p", id: "m" } } },
    messages: { ses_main: [{ info: { id: "msg_1", role: "user" } }] },
    created,
    navigated,
    toasts,
    deleted,
    getCurrentSessionID: () => deps.currentSessionID,
    getSession: (id) => deps.sessions[id],
    getMessages: (id) => deps.messages[id] ?? [],
    createSession: async (input) => {
      created.push(input)
      return { id: `ses_side_${created.length}`, title: input.title }
    },
    navigateSession: (id) => navigated.push(id),
    abortSession: async () => {},
    deleteSession: async (id) => {
      deleted.push(id)
    },
    showToast: (message) => toasts.push(message),
    requestRender: () => {},
  }
  return deps
}

function promptRef(input = "") {
  return {
    hasAttachments: false,
    input,
    set(value) {
      this.input = value
    },
    submit() {},
  }
}

describe("#given the controller state machine", () => {
  test("#when a /btw draft starts a side #then it creates a metadata-bearing session and retains it", async () => {
    // given
    const deps = controllerHarness()
    const controller = createBtwController(deps)
    const prompt = promptRef("/btw explain the parser")

    // when
    const started = await controller.startFromPrompt(prompt)

    // then
    expect(started).toBe(true)
    expect(controller.state()).toEqual({ phase: "open", parentSessionID: "ses_main", sideSessionID: "ses_side_1", owned: true })
    expect(controller.sides()).toHaveLength(1)
    expect(controller.rootParent("ses_side_1")).toBe("ses_main")
    expect(prompt.input).toBe("")
    const metadata = deps.created[0].metadata[BTW_SIDE_METADATA_KEY]
    expect(metadata).toEqual({ version: 1, parent_session_id: "ses_main", boundary_message_id: "msg_1" })
    expect(deps.navigated).toContain("ses_side_1")
  })

  test("#when a second side starts #then both sides are retained", async () => {
    // given
    const deps = controllerHarness()
    const controller = createBtwController(deps)
    await controller.startFromPrompt(promptRef("/btw first"))

    // when
    await controller.startFromPrompt(promptRef("/btw second"))

    // then
    expect(controller.sides()).toHaveLength(2)
  })

  test("#when the side session is deleted during creation #then the start is tombstoned and nothing is retained", async () => {
    // given
    const deps = controllerHarness()
    let controller
    deps.createSession = async (input) => {
      deps.created.push(input)
      controller.handleSessionDeleted("ses_side")
      return { id: "ses_side", title: input.title }
    }
    controller = createBtwController(deps)

    // when
    const started = await controller.startFromPrompt(promptRef("/btw race"))

    // then
    expect(started).toBe(false)
    expect(controller.side("ses_side")).toBeUndefined()
    expect(controller.state().phase).toBe("closed")
    // The race guard consumes the tombstone it matched; no stray side is retained.
    expect(controller.tombstoneCount()).toBe(0)
  })

  test("#when tombstones overflow #then the oldest are evicted (bounded FIFO)", async () => {
    // given
    const deps = controllerHarness()
    const controller = createBtwController(deps)

    // when
    for (let index = 0; index < MAX_DELETED_SESSION_TOMBSTONES + 5; index += 1) {
      controller.handleSessionDeleted(`ses_${index}`)
    }

    // then
    expect(controller.tombstoneCount()).toBe(MAX_DELETED_SESSION_TOMBSTONES)
    expect(controller.isSessionTombstoned("ses_0")).toBe(false)
    expect(controller.isSessionTombstoned(`ses_${MAX_DELETED_SESSION_TOMBSTONES + 4}`)).toBe(true)
  })

  test("#when the side is closed #then it is aborted, deleted, and removed from the retained set", async () => {
    // given
    const deps = controllerHarness()
    const controller = createBtwController(deps)
    await controller.startFromPrompt(promptRef("/btw close me"))
    deps.currentSessionID = "ses_side_1"

    // when
    await controller.close()

    // then
    expect(deps.deleted).toContain("ses_side_1")
    expect(controller.side("ses_side_1")).toBeUndefined()
    expect(controller.state().phase).toBe("closed")
  })

  test("#when an adopted side is present and returns #then it navigates to the parent", async () => {
    // given
    const deps = controllerHarness()
    const controller = createBtwController(deps)
    controller.adopt("ses_main", "ses_adopted", 1)
    deps.currentSessionID = "ses_adopted"

    // when
    controller.returnToParent()

    // then
    expect(deps.navigated.at(-1)).toBe("ses_main")
    expect(controller.sideNumber("ses_adopted")).toBe(1)
  })
})

describe("#given the double-escape return", () => {
  function escape() {
    return { event: { eventType: "press", name: "escape" }, consume: () => {} }
  }

  test("#when escape is pressed twice inside the window #then it returns to the parent once", () => {
    // given
    let now = 1_000
    let returns = 0
    let cleared = 0
    const escapeReturn = createBtwEscapeReturn({
      isCurrentSideIdle: () => true,
      isDialogOpen: () => false,
      clearPending: () => {
        cleared += 1
      },
      returnToParent: () => {
        returns += 1
      },
      now: () => now,
    })

    // when
    expect(escapeReturn.handle(escape())).toBe(false)
    now = 1_500
    expect(escapeReturn.handle(escape())).toBe(true)

    // then
    expect(returns).toBe(1)
    expect(cleared).toBe(1)
  })

  test("#when the two escapes are too far apart #then nothing returns", () => {
    // given
    let now = 1_000
    let returns = 0
    const escapeReturn = createBtwEscapeReturn({
      isCurrentSideIdle: () => true,
      isDialogOpen: () => false,
      clearPending: () => {},
      returnToParent: () => {
        returns += 1
      },
      now: () => now,
    })

    // when
    escapeReturn.handle(escape())
    now = 5_000
    escapeReturn.handle(escape())

    // then
    expect(returns).toBe(0)
  })

  test("#when a dialog is open #then escape is ignored", () => {
    // given
    let returns = 0
    const escapeReturn = createBtwEscapeReturn({
      isCurrentSideIdle: () => true,
      isDialogOpen: () => true,
      clearPending: () => {},
      returnToParent: () => {
        returns += 1
      },
      now: () => 1_000,
    })

    // when
    escapeReturn.handle(escape())
    escapeReturn.handle(escape())

    // then
    expect(returns).toBe(0)
  })
})

describe("#given the picker options", () => {
  const catalog = {
    main: { id: "ses_main", title: "Main work" },
    sides: [
      { id: "ses_s1", title: "BTW · parser question" },
      { id: "ses_s2", title: "Untitled" },
    ],
  }

  test("#when a picker value is parsed #then session and new selections are distinguished", () => {
    expect(parseBtwPickerValue(`${BTW_PICKER_SESSION_PREFIX}ses_1`)).toEqual({ type: "session", sessionID: "ses_1" })
    expect(parseBtwPickerValue(`${BTW_PICKER_NEW_PREFIX}ses_main`)).toEqual({ type: "new", parentSessionID: "ses_main" })
    expect(parseBtwPickerValue("empty")).toBeUndefined()
    expect(parseBtwPickerValue(`${BTW_PICKER_SESSION_PREFIX}`)).toBeUndefined()
  })

  test("#when built from a catalog #then Main, retained sides, and New BTW are offered", () => {
    // when
    const { options, current } = buildBtwPickerOptions(catalog, "ses_s1")

    // then
    expect(options[0].value).toBe(`${BTW_PICKER_SESSION_PREFIX}ses_main`)
    expect(options.some((option) => option.value === `${BTW_PICKER_SESSION_PREFIX}ses_s1`)).toBe(true)
    expect(options.some((option) => option.value === `${BTW_PICKER_NEW_PREFIX}ses_main`)).toBe(true)
    expect(current).toBe(`${BTW_PICKER_SESSION_PREFIX}ses_s1`)
    expect(options.find((option) => option.value.startsWith("session:ses_s1")).title).toBe("BTW #1 · parser question")
  })

  test("#when the catalog classifies sessions #then only sides of the same main are grouped", () => {
    // given
    const sideMetadata = { version: 1, parent_session_id: "ses_main", boundary_message_id: "m" }
    const sessions = [
      { id: "ses_main", title: "Main", time: { created: 1 } },
      { id: "ses_s1", title: "BTW · a", time: { created: 2 }, metadata: { [BTW_SIDE_METADATA_KEY]: sideMetadata } },
      { id: "ses_other", title: "Other", time: { created: 3 } },
    ]

    // when
    const result = classifyBtwSessionCatalog(sessions, "ses_main")

    // then
    expect(result.main.id).toBe("ses_main")
    expect(result.sides.map((session) => session.id)).toEqual(["ses_s1"])
  })

  test("#when candidate parents are listed #then BTW sides are excluded", () => {
    // given
    const sideMetadata = { version: 1, parent_session_id: "ses_main", boundary_message_id: "m" }
    const sessions = [
      { id: "ses_main", title: "Main", time: { created: 1 } },
      { id: "ses_s1", title: "BTW · a", time: { created: 2 }, metadata: { [BTW_SIDE_METADATA_KEY]: sideMetadata } },
    ]

    // then
    expect(candidateParentSessions(sessions).map((session) => session.id)).toEqual(["ses_main"])
  })
})

describe("#given prepareBtwSideStart", () => {
  test("#when the draft carries attachments #then start is refused", () => {
    // given
    const deps = controllerHarness()
    const prompt = { hasAttachments: true, input: "/btw x", set() {}, submit() {} }

    // when
    const prepared = prepareBtwSideStart(deps, prompt)

    // then
    expect(prepared).toBeUndefined()
    expect(deps.toasts.at(-1)).toContain("text-only")
  })
})

describe("#given the BTW prompt queue", () => {
  test("#when a question is queued before the prompt ref attaches #then it is delivered on attach", () => {
    // given
    const queue = createBtwPromptQueue()
    const submitted = []
    const ref = {
      input: "",
      hasAttachments: false,
      set(value) {
        this.input = value
      },
      submit() {
        submitted.push(this.input)
      },
    }

    // when
    queue.queue("ses_side", "queued question")
    queue.attach("ses_side", ref)

    // then
    expect(ref.input).toBe("queued question")
    expect(submitted).toEqual(["queued question"])
    expect(queue.input("ses_side")).toBe("queued question")
  })
})
