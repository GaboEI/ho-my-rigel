import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DAY_MS,
  NUDGE_AUTO_SHOW_CAP,
  NUDGE_CORRUPT_RECOVERY_MS,
  NUDGE_INTERVALS_MS,
  NUDGE_SNOOZE_MS,
  NUDGE_STATE_VERSION,
  decideNativeEditionNudge,
  detectNativeEdition,
  isInteractiveSession,
  nativeEditionAgentDir,
  snoozedState,
} from "./rigel-v2-native-nudge-core.mjs"
import {
  createNudgeStateStore,
  NUDGE_STATE_FILE,
  parseNudgeState,
  resolveNudgeStateDir,
} from "./rigel-v2-native-nudge-state.mjs"

const NOW = 1_700_000_000_000

function state(overrides = {}) {
  return {
    schemaVersion: NUDGE_STATE_VERSION,
    autoShows: 0,
    lastShownAt: null,
    nextEligibleAt: NOW,
    decision: "none",
    decidedAt: null,
    writtenBy: "test",
    ...overrides,
  }
}

function eligible(overrides = {}) {
  return {
    now: NOW,
    state: "missing",
    nativeEditionInstalled: false,
    hookDisabled: false,
    interactive: true,
    childSession: false,
    shownThisProcess: false,
    stateWritable: true,
    toastAvailable: true,
    version: "test",
    ...overrides,
  }
}

describe("the nudge shows for a user who can act on it", () => {
  test("#given a first eligible session #when decided #then it shows and schedules the next window", () => {
    // given / when
    const decision = decideNativeEditionNudge(eligible())

    // then
    expect(decision.show).toBe(true)
    expect(decision.reason).toBe("eligible")
    expect(decision.nextState?.autoShows).toBe(1)
    expect(decision.nextState?.nextEligibleAt).toBeGreaterThan(NOW)
  })

  test("#given the first accepted showing #when scheduled #then the interval is three days", () => {
    // given / when
    const decision = decideNativeEditionNudge(eligible())

    // then
    expect(decision.nextState?.nextEligibleAt).toBe(NOW + NUDGE_INTERVALS_MS[0])
  })
})

describe("every suppression condition, each beside its control", () => {
  const conditions = [
    { name: "the native edition is already installed", patch: { nativeEditionInstalled: true }, reason: "already-migrated" },
    { name: "the hook is disabled", patch: { hookDisabled: true }, reason: "opted-out" },
    { name: "the session is non-interactive", patch: { interactive: false }, reason: "non-interactive" },
    { name: "the session is a child session", patch: { childSession: true }, reason: "child-session" },
    { name: "it already fired in this process", patch: { shownThisProcess: true }, reason: "already-shown-this-process" },
    { name: "the toast API is unavailable", patch: { toastAvailable: false }, reason: "toast-unavailable" },
    { name: "the state directory is unwritable", patch: { stateWritable: false }, reason: "state-unwritable" },
    { name: "the user said never", patch: { state: state({ decision: "never" }) }, reason: "opted-out" },
    { name: "the user already migrated", patch: { state: state({ decision: "migrated" }) }, reason: "already-migrated" },
    { name: "the lifetime cap is reached", patch: { state: state({ autoShows: NUDGE_AUTO_SHOW_CAP }) }, reason: "lifetime-cap-reached" },
    { name: "the next window has not opened", patch: { state: state({ nextEligibleAt: NOW + 1 }) }, reason: "not-yet-eligible" },
  ]

  for (const condition of conditions) {
    test(`#given ${condition.name} #when decided #then it stays silent`, () => {
      // given / when
      const decision = decideNativeEditionNudge(eligible(condition.patch))

      // then
      expect(decision.show).toBe(false)
      expect(decision.reason).toBe(condition.reason)
    })

    test(`#given ${condition.name} is cleared #when decided #then it shows`, () => {
      // given / when
      const decision = decideNativeEditionNudge(eligible())

      // then
      expect(decision.show).toBe(true)
    })
  }
})

describe("a dismissal survives a damaged state file", () => {
  test("#given never with every sibling field corrupted #when decided #then it still stays silent", () => {
    // given
    const damaged = { ...state({ decision: "never" }), autoShows: -999, nextEligibleAt: 0, schemaVersion: 99 }

    // when
    const decision = decideNativeEditionNudge(eligible({ state: damaged }))

    // then
    expect(decision.show).toBe(false)
    expect(decision.reason).toBe("opted-out")
  })

  test("#given an unparseable state file #when decided #then it defers rather than showing now", () => {
    // given / when
    const decision = decideNativeEditionNudge(eligible({ state: "corrupt" }))

    // then
    expect(decision.show).toBe(false)
    expect(decision.reason).toBe("state-corrupt-recovering")
    expect(decision.nextState?.nextEligibleAt).toBe(NOW + NUDGE_CORRUPT_RECOVERY_MS)
  })
})

describe("the lifetime cap is reached by repeated showings", () => {
  test("#given the nudge is accepted each time it is offered #when the cap is hit #then it never shows again", () => {
    // given
    let current = "missing"
    let shows = 0
    let clock = NOW

    // when
    for (let attempt = 0; attempt < NUDGE_AUTO_SHOW_CAP + 3; attempt += 1) {
      const decision = decideNativeEditionNudge(eligible({ now: clock, state: current }))
      if (decision.show) {
        shows += 1
        current = decision.nextState
        clock = decision.nextState.nextEligibleAt
        continue
      }
      clock += 365 * DAY_MS
    }

    // then
    expect(shows).toBe(NUDGE_AUTO_SHOW_CAP)
  })

  test("#given accepted showings #when the interval is scheduled #then it grows 3, 7, 14 days and clamps at 14", () => {
    // given
    let current = "missing"
    let clock = NOW
    const intervals = []

    // when
    for (let attempt = 0; attempt < NUDGE_AUTO_SHOW_CAP; attempt += 1) {
      const decision = decideNativeEditionNudge(eligible({ now: clock, state: current }))
      intervals.push(decision.nextState.nextEligibleAt - clock)
      current = decision.nextState
      clock = decision.nextState.nextEligibleAt
    }

    // then
    expect(intervals.slice(0, 3)).toEqual([3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS])
    expect(intervals[3]).toBe(14 * DAY_MS)
  })
})

describe("a user-requested snooze is a distinct state", () => {
  test("#given a snooze #when built #then it defers a week and records the decision", () => {
    // given / when
    const next = snoozedState(state(), NOW, "test")

    // then
    expect(next.nextEligibleAt).toBe(NOW + NUDGE_SNOOZE_MS)
    expect(next.decision).toBe("snoozed")
    expect(next.decidedAt).toBe(NOW)
  })
})

describe("interactivity is decided purely from the environment and TTY", () => {
  test("#given CI is set #when decided #then it is non-interactive", () => {
    // given / when / then
    expect(isInteractiveSession({ CI: "true" }, true)).toBe(false)
  })

  test("#given an empty CI #when decided #then it stays interactive", () => {
    // given / when / then
    expect(isInteractiveSession({ CI: "" }, true)).toBe(true)
  })

  test("#given OMO_NON_INTERACTIVE=1 #when decided #then it is non-interactive", () => {
    // given / when / then
    expect(isInteractiveSession({ OMO_NON_INTERACTIVE: "1" }, true)).toBe(false)
  })

  test("#given a TTY #when decided #then it is interactive", () => {
    // given / when / then
    expect(isInteractiveSession({}, true)).toBe(true)
  })

  test("#given no TTY #when decided #then it is non-interactive", () => {
    // given / when / then
    expect(isInteractiveSession({}, false)).toBe(false)
  })
})

describe("native install detection probes the canonical agent dir", () => {
  test("#given the agent dir exists #when probed #then it reports installed", () => {
    // given
    const home = "/home/example"
    const seen = []

    // when
    const installed = detectNativeEdition({ existsSync: (p) => { seen.push(p); return true }, home })

    // then
    expect(installed).toBe(true)
    expect(seen).toEqual([nativeEditionAgentDir(home)])
  })

  test("#given the probe throws #when detected #then it reports not installed", () => {
    // given / when
    const installed = detectNativeEdition({ existsSync: () => { throw new Error("boom") }, home: "/home/example" })

    // then
    expect(installed).toBe(false)
  })

  test("#given no dependencies #when detected #then it reports not installed", () => {
    // given / when / then
    expect(detectNativeEdition({})).toBe(false)
  })
})

describe("the state root follows the XDG contract", () => {
  test("#given XDG_STATE_HOME #when resolved #then it is used", () => {
    // given / when / then
    expect(resolveNudgeStateDir({ env: { XDG_STATE_HOME: "/xdg/state" }, home: "/home/example" })).toBe(
      join("/xdg/state", "oh-my-rigel"),
    )
  })

  test("#given no XDG_STATE_HOME #when resolved #then the home fallback is used", () => {
    // given / when / then
    expect(resolveNudgeStateDir({ env: {}, home: "/home/example" })).toBe(
      join("/home/example", ".local", "state", "oh-my-rigel"),
    )
  })
})

describe("the nudge state survives a round trip", () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rigel-nudge-state-"))
  })

  afterEach(() => {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  function sample() {
    return {
      schemaVersion: NUDGE_STATE_VERSION,
      autoShows: 2,
      lastShownAt: 1_700_000_000_000,
      nextEligibleAt: 1_700_600_000_000,
      decision: "snoozed",
      decidedAt: 1_700_000_000_000,
      writtenBy: "5.0.0-test",
    }
  }

  test("#given a written state #when read back #then every field is preserved", () => {
    // given
    const store = createNudgeStateStore(dir)

    // when
    expect(store.write(sample())).toBe(true)

    // then
    expect(store.read()).toEqual(sample())
  })

  test("#given no state file #when read #then it reports missing rather than throwing", () => {
    // given / when / then
    expect(createNudgeStateStore(dir).read()).toBe("missing")
  })

  test("#given a written state #when the file is inspected #then it carries the documented name", () => {
    // given
    createNudgeStateStore(dir).write(sample())

    // when
    const raw = Bun.file(join(dir, NUDGE_STATE_FILE))

    // then
    expect(raw.size).toBeGreaterThan(0)
  })

  test("#given a file written by a future version #when read #then unknown fields do not make it corrupt", () => {
    // given
    writeFileSync(join(dir, NUDGE_STATE_FILE), JSON.stringify({ ...sample(), somethingNew: true, schemaVersion: 99 }))

    // when
    const parsed = createNudgeStateStore(dir).read()

    // then
    expect(parsed).not.toBe("corrupt")
  })
})

describe("a damaged state file never crashes the session", () => {
  test.each([
    ["unparseable json", "{not json"],
    ["a json array", "[]"],
    ["a decision outside the enum", JSON.stringify({ decision: "maybe", nextEligibleAt: 1 })],
    ["a missing schedule", JSON.stringify({ decision: "none" })],
    ["a negative schedule", JSON.stringify({ decision: "none", nextEligibleAt: -1 })],
  ])("#given %s #when parsed #then it reports corrupt", (_label, raw) => {
    // given / when / then
    expect(parseNudgeState(raw)).toBe("corrupt")
  })

  test("#given a valid decision with junk siblings #when parsed #then the decision survives and junk is defaulted", () => {
    // given
    const raw = JSON.stringify({ decision: "never", nextEligibleAt: 10, autoShows: -5, lastShownAt: "x" })

    // when
    const parsed = parseNudgeState(raw)

    // then
    expect(parsed).not.toBe("corrupt")
    expect(parsed === "corrupt" || parsed === "missing" ? null : parsed.decision).toBe("never")
    expect(parsed === "corrupt" || parsed === "missing" ? null : parsed.autoShows).toBe(0)
  })
})

describe("writability is probed rather than assumed", () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rigel-nudge-write-"))
  })

  afterEach(() => {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  test("#given a writable directory #when probed #then it reports writable and leaves no state file", () => {
    // given
    const store = createNudgeStateStore(dir)

    // when
    const writable = store.probeWritable()

    // then
    expect(writable).toBe(true)
    expect(createNudgeStateStore(dir).read()).toBe("missing")
  })

  test("#given a store path whose parent is a file #when probed #then it reports unwritable instead of throwing", () => {
    // given
    const notADir = join(dir, "not-a-dir")
    writeFileSync(notADir, "")
    const locked = join(notADir, "locked")

    // when
    const writable = createNudgeStateStore(locked).probeWritable()

    // then
    expect(writable).toBe(false)
  })

  test("#given a store path whose parent is a file #when a write is attempted #then it returns false rather than throwing", () => {
    // given
    const notADir = join(dir, "not-a-dir")
    writeFileSync(notADir, "")
    const locked = join(notADir, "locked-write")

    // when / then
    expect(createNudgeStateStore(locked).write({ schemaVersion: 1 })).toBe(false)
  })

  test.skipIf(process.platform === "win32")("#given a read-only directory #when probed #then it reports unwritable instead of throwing", () => {
    // given
    const locked = join(dir, "locked")
    mkdirSync(locked, { recursive: true })
    chmodSync(locked, 0o500)

    // when
    const writable = createNudgeStateStore(locked).probeWritable()

    // then
    expect(writable).toBe(false)
  })
})

describe("the store accepts injected fs primitives", () => {
  test("#given injected fs #when written and read #then the injection is used", () => {
    // given
    const files = new Map()
    const deps = {
      mkdirSync: () => {},
      unlinkSync: () => {},
      writeFileSync: (path, body) => files.set(path, body),
      readFileSync: (path) => {
        if (!files.has(path)) throw new Error("ENOENT")
        return files.get(path)
      },
    }
    const store = createNudgeStateStore("/virtual", deps)

    // when
    const wrote = store.write(state())
    const read = store.read()

    // then
    expect(wrote).toBe(true)
    expect(read.autoShows).toBe(0)
  })
})
