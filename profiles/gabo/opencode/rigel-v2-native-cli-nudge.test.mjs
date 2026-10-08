import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  NATIVE_INSTALL_ENTRY_COMMAND,
  NATIVE_NUDGE_OPTIONS,
  NATIVE_NUDGE_TOAST_MESSAGE,
  NATIVE_NUDGE_TOAST_TITLE,
  applyNativeEditionNudgeAction,
  createNudgeCliSurface,
} from "./rigel-v2-native-cli-nudge.mjs"
import { NUDGE_SNOOZE_MS } from "./rigel-v2-native-nudge-core.mjs"

const NOW = 1_700_000_000_000
const ENABLED = { nativeEditionNudge: { enabled: true } }

function fakeStore(initial = "missing", options = {}) {
  let current = initial
  const writes = []
  const store = {
    read: () => current,
    write: (state) => {
      if (options.writeFails === true) return false
      writes.push(state)
      current = state
      return true
    },
    probeWritable: () => options.writable !== false,
  }
  return { store, writes }
}

function fakeContext({ options, renderer = { isDestroyed: false }, sessions = {}, toastThrows = false } = {}) {
  const handlers = new Map()
  const toasts = []
  const unsubscribed = []
  const keymapLayers = []
  const dialogCalls = []
  let keymapDisposed = 0
  let dialogCleared = 0

  const api = {
    options,
    renderer,
    location: { current: { directory: "/tmp/work" } },
    data: {
      on(name, handler) {
        handlers.set(name, handler)
        return () => {
          handlers.delete(name)
          unsubscribed.push(name)
        }
      },
      session: { get: (id) => sessions[id] },
    },
    ui: {
      toast: {
        show: (toast) => {
          if (toastThrows) throw new Error("toast exploded")
          toasts.push(toast)
        },
      },
      dialog: {
        select: (spec) => dialogCalls.push(spec),
        clear: () => {
          dialogCleared += 1
        },
        show: () => {},
      },
    },
    keymap: {
      layer(fn) {
        keymapLayers.push(fn)
        return () => {
          keymapDisposed += 1
        }
      },
    },
  }

  return {
    api,
    handlers,
    toasts,
    unsubscribed,
    keymapLayers,
    dialogCalls,
    get keymapDisposed() {
      return keymapDisposed
    },
    get dialogCleared() {
      return dialogCleared
    },
    handler: (name) => handlers.get(name),
  }
}

let logDir
let logFile
let stateDir

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "rigel-cli-nudge-"))
  logFile = join(logDir, "native-nudge.log")
  stateDir = mkdtempSync(join(tmpdir(), "rigel-cli-nudge-state-"))
})

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

function deps(extra = {}) {
  // Hermetic defaults: a unit test must never depend on whether the real
  // `~/.omo/agent` exists or whether the test runner has a TTY.
  return { now: () => NOW, version: "test", logFile, stateDir, detectNativeEdition: () => false, interactive: () => true, ...extra }
}

function sessionCreated(sessionID = "ses_1") {
  return { type: "session.created", data: { sessionID } }
}

describe("V1 parity gating (default-on, explicit kill switch)", () => {
  test("#given no nudge config #when setup runs #then the surface is default-on and registers", () => {
    // given
    const fake = fakeContext({ options: {} })

    // when
    const cleanup = createNudgeCliSurface(deps()).setup(fake.api)

    // then
    expect(typeof cleanup).toBe("function")
    expect(fake.handlers.size).toBeGreaterThan(0)
  })

  test("#given an explicit enabled:false #when setup runs #then it stays inert", () => {
    // given
    const fake = fakeContext({ options: { nativeEditionNudge: { enabled: false } } })

    // when
    const cleanup = createNudgeCliSurface(deps()).setup(fake.api)

    // then
    expect(cleanup).toBeUndefined()
    expect(fake.handlers.size).toBe(0)
  })

  test("#given a headless renderer #when setup runs #then it registers nothing", () => {
    // given
    const fake = fakeContext({ options: ENABLED, renderer: null })

    // when
    const cleanup = createNudgeCliSurface(deps()).setup(fake.api)

    // then
    expect(cleanup).toBeUndefined()
    expect(fake.handlers.size).toBe(0)
  })
})

describe("the hook toast reaches the real toast surface", () => {
  test("#given an eligible session #when session.created fires #then exactly one toast carries the install command", () => {
    // given
    const fake = fakeContext({ options: ENABLED, sessions: { ses_1: { id: "ses_1" } } })
    const { store, writes } = fakeStore("missing")
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated("ses_1"))

    // then
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0].title).toBe(NATIVE_NUDGE_TOAST_TITLE)
    expect(fake.toasts[0].message).toBe(NATIVE_NUDGE_TOAST_MESSAGE)
    expect(fake.toasts[0].message).toContain(NATIVE_INSTALL_ENTRY_COMMAND)
    expect(fake.toasts[0].variant).toBe("info")
    expect(writes).toHaveLength(1)
    expect(writes[0].autoShows).toBe(1)
    expect(writes[0].writtenBy).toBe("test")
  })

  test("#given repeated session events in one process #when they fire #then the toast shows once", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore("missing")
    createNudgeCliSurface(deps({ store })).setup(fake.api)
    const handler = fake.handler("session.created")

    // when
    handler(sessionCreated())
    handler(sessionCreated())
    handler(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(1)
  })

  test("#given a child session #when session.created fires #then nothing is shown", () => {
    // given
    const fake = fakeContext({ options: ENABLED, sessions: { ses_child: { id: "ses_child", parentID: "ses_root" } } })
    const { store } = fakeStore("missing")
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated("ses_child"))

    // then
    expect(fake.toasts).toHaveLength(0)
  })
})

describe("the nudge stays silent for a user who cannot act on it", () => {
  test("#given the native edition is already installed #when session.created fires #then nothing is shown", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore("missing")
    createNudgeCliSurface(deps({ store, detectNativeEdition: () => true })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
  })

  test("#given a non-interactive session #when session.created fires #then nothing is shown", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore("missing")
    createNudgeCliSurface(deps({ store, interactive: () => false })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
  })

  test("#given the user said never #when session.created fires #then nothing is shown", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore({
      schemaVersion: 1,
      autoShows: 0,
      lastShownAt: null,
      nextEligibleAt: NOW,
      decision: "never",
      decidedAt: NOW,
      writtenBy: "test",
    })
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
  })
})

describe("a nudge that cannot be recorded is never shown", () => {
  test("#given the state write fails #when session.created fires #then the toast is suppressed", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore("missing", { writeFails: true })
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
  })

  test("#given an unwritable state directory #when session.created fires #then the toast is suppressed and nothing is written", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store, writes } = fakeStore("missing", { writable: false })
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })
})

describe("a contained effect failure never throws into the host", () => {
  test("#given the toast throws #when session.created fires #then the handler does not throw and logs the failure", () => {
    // given
    const fake = fakeContext({ options: ENABLED, toastThrows: true })
    const { store } = fakeStore("missing")
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when / then
    expect(() => fake.handler("session.created")(sessionCreated())).not.toThrow()
    expect(existsSync(logFile)).toBe(true)
  })
})

describe("the /native command opens the feature dialog", () => {
  test("#given the surface is set up #when the keymap layer runs #then the command carries the native slash and omo-native alias", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore("missing")
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    const layer = fake.keymapLayers[0]()

    // then
    expect(layer.commands).toHaveLength(1)
    expect(layer.commands[0].slash.name).toBe("native")
    expect(layer.commands[0].slash.aliases).toEqual(["omo-native"])
  })

  test("#given the command runs #when the dialog opens #then it offers install, guide, later and never", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore("missing")
    createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    fake.keymapLayers[0]().commands[0].onSelect()

    // then
    expect(fake.dialogCalls).toHaveLength(1)
    expect(fake.dialogCalls[0].options.map((option) => option.value)).toEqual(["install", "guide", "later", "never"])
  })

  test("#given the dialog is open #when an action is selected #then the state is written, the dialog clears and a toast shows", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store, writes } = fakeStore("missing")
    createNudgeCliSurface(deps({ store })).setup(fake.api)
    const dialog = fake.keymapLayers[0]().commands[0].onSelect()

    // when
    fake.dialogCalls[0].onSelect({ value: "later" })

    // then
    expect(writes).toHaveLength(1)
    expect(writes[0].decision).toBe("snoozed")
    expect(writes[0].nextEligibleAt).toBe(NOW + NUDGE_SNOOZE_MS)
    expect(fake.dialogCleared).toBe(1)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0].message).toBe("I'll mention OmO Native again in a week.")
  })
})

describe("the surface is disposed cleanly", () => {
  test("#given a set-up surface #when disposed #then the subscription and the keymap layer are released", () => {
    // given
    const fake = fakeContext({ options: ENABLED })
    const { store } = fakeStore("missing")
    const cleanup = createNudgeCliSurface(deps({ store })).setup(fake.api)

    // when
    cleanup()

    // then
    expect(fake.unsubscribed).toContain("session.created")
    expect(fake.keymapDisposed).toBe(1)
  })
})

describe("each dialog action maps to its documented effect", () => {
  test("#given install #when applied #then the command is returned and no state is written", () => {
    // given
    const fake = fakeStore("missing")

    // when
    const result = applyNativeEditionNudgeAction("install", { store: fake.store, now: NOW })

    // then
    expect(result.toast).toContain(NATIVE_INSTALL_ENTRY_COMMAND)
    expect(result.toast).toContain("omo setup")
    expect(fake.writes).toHaveLength(0)
  })

  test("#given guide #when applied #then it defers a week and returns the guide url", () => {
    // given
    const fake = fakeStore("missing")

    // when
    const result = applyNativeEditionNudgeAction("guide", { store: fake.store, now: NOW })

    // then
    expect(fake.writes[0].nextEligibleAt).toBe(NOW + NUDGE_SNOOZE_MS)
    expect(result.toast).toBe("Opening the OmO Native guide.")
    expect(result.url).toContain("docs/guide/migrating-from-opencode.md")
  })

  test("#given later #when applied #then it snoozes without consuming a showing", () => {
    // given
    const fake = fakeStore({
      schemaVersion: 1,
      autoShows: 2,
      lastShownAt: NOW,
      nextEligibleAt: NOW,
      decision: "none",
      decidedAt: null,
      writtenBy: "test",
    })

    // when
    applyNativeEditionNudgeAction("later", { store: fake.store, now: NOW })

    // then
    expect(fake.writes[0].decision).toBe("snoozed")
    expect(fake.writes[0].nextEligibleAt).toBe(NOW + NUDGE_SNOOZE_MS)
    expect(fake.writes[0].autoShows).toBe(2)
  })

  test("#given never #when applied #then the permanent decision is dated", () => {
    // given
    const fake = fakeStore("missing")

    // when
    const result = applyNativeEditionNudgeAction("never", { store: fake.store, now: NOW })

    // then
    expect(fake.writes[0].decision).toBe("never")
    expect(fake.writes[0].decidedAt).toBe(NOW)
    expect(result.toast).toContain("command palette")
  })

  test("#given a corrupt state file #when later is applied #then it recovers to a fresh base state", () => {
    // given
    const fake = fakeStore("corrupt")

    // when
    applyNativeEditionNudgeAction("later", { store: fake.store, now: NOW })

    // then
    expect(fake.writes[0].decision).toBe("snoozed")
    expect(fake.writes[0].autoShows).toBe(0)
  })
})

describe("the option list is stable", () => {
  test("#given the options #when read #then they are install, guide, later and never", () => {
    // given / when / then
    expect(NATIVE_NUDGE_OPTIONS.map((option) => option.value)).toEqual(["install", "guide", "later", "never"])
  })
})
