import { describe, expect, test } from "bun:test"
import {
  NOTIFICATION_DEFAULTS,
  buildIdleContent,
  collapseWhitespace,
  createIdleScheduler,
  extractMessageText,
  extractRequestID,
  extractRequestTitle,
  extractSessionID,
  getLastNonEmptyLine,
  isActivityEvent,
  isNotifiableSession,
  isPermissionHint,
  messageRole,
  notificationSoundName,
  resolveNotificationConfig,
} from "./rigel-v2-native-notification-core.mjs"

/** Deterministic timer harness: manual clock plus a queue of armed callbacks. */
function createClock() {
  let current = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => current,
    setTimer: (callback, delay) => {
      const id = nextId++
      timers.set(id, { callback, at: current + delay })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    advance: async (ms) => {
      current += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= current) {
          timers.delete(id)
          timer.callback()
        }
      }
      await Promise.resolve()
      await Promise.resolve()
    },
    pending: () => timers.size,
  }
}

describe("resolveNotificationConfig", () => {
  test("#given no config #then the feature is inert", () => {
    expect(resolveNotificationConfig(undefined)).toBeNull()
    expect(resolveNotificationConfig(null)).toBeNull()
    expect(resolveNotificationConfig({})).toBeNull()
  })

  test("#given enabled false #then the feature is inert", () => {
    expect(resolveNotificationConfig({ enabled: false })).toBeNull()
  })

  test("#given enabled true #then V1 defaults apply", () => {
    const config = resolveNotificationConfig({ enabled: true })
    expect(config.title).toBe(NOTIFICATION_DEFAULTS.title)
    expect(config.idleConfirmationDelay).toBe(1500)
    expect(config.skipIfIncompleteTodos).toBe(true)
    expect(config.enforceMainSessionFilter).toBe(true)
    expect(config.playSound).toBe(false)
  })

  test("#given malformed overrides #then defaults win", () => {
    const config = resolveNotificationConfig({
      enabled: true,
      title: 42,
      idleConfirmationDelay: -1,
      maxTrackedSessions: "many",
      activityGracePeriodMs: -5,
      playSound: "yes",
    })
    expect(config.title).toBe(NOTIFICATION_DEFAULTS.title)
    expect(config.idleConfirmationDelay).toBe(1500)
    expect(config.maxTrackedSessions).toBe(100)
    expect(config.activityGracePeriodMs).toBe(100)
    expect(config.playSound).toBe(false)
  })

  test("#given valid overrides #then they are honored", () => {
    const config = resolveNotificationConfig({ enabled: true, playSound: true, soundName: "chime", idleConfirmationDelay: 20 })
    expect(config.playSound).toBe(true)
    expect(config.soundName).toBe("chime")
    expect(config.idleConfirmationDelay).toBe(20)
  })
})

describe("event extraction", () => {
  test("#given the V2 event envelope #then the session id resolves", () => {
    expect(extractSessionID({ data: { sessionID: "ses_a" } })).toBe("ses_a")
    expect(extractSessionID({ sessionID: "ses_b" })).toBe("ses_b")
    expect(extractSessionID({ data: { form: { sessionID: "ses_c" } } })).toBe("ses_c")
    expect(extractSessionID({})).toBeUndefined()
  })

  test("#given a permission or form envelope #then the request id resolves for dedup", () => {
    expect(extractRequestID({ data: { id: "req_1" } })).toBe("req_1")
    expect(extractRequestID({ data: { form: { id: "form_1" } } })).toBe("form_1")
    expect(extractRequestID({ data: { requestID: "req_2" } })).toBe("req_2")
  })

  test("#given a form envelope #then its title resolves", () => {
    expect(extractRequestTitle({ data: { form: { title: "Pick a directory" } } })).toBe("Pick a directory")
    expect(extractRequestTitle({ data: { form: {} } })).toBeUndefined()
  })
})

describe("message text extraction", () => {
  test("#given a V2 user message #then the text field is used", () => {
    expect(extractMessageText({ type: "user", text: "hello" })).toBe("hello")
    expect(messageRole({ type: "user", text: "hello" })).toBe("user")
  })

  test("#given a V2 assistant message #then text parts are joined", () => {
    const message = { type: "assistant", content: [{ type: "reasoning", text: "no" }, { type: "text", text: "done" }] }
    expect(extractMessageText(message)).toBe("done")
    expect(messageRole(message)).toBe("assistant")
  })

  test("#given malformed input #then extraction never throws", () => {
    expect(extractMessageText(undefined)).toBe("")
    expect(extractMessageText({ content: "nope" })).toBe("")
    expect(messageRole(undefined)).toBeUndefined()
  })
})

describe("buildIdleContent", () => {
  test("#given a session with messages #then title and detail lines match V1", () => {
    const content = buildIdleContent({
      baseTitle: "OpenCode",
      baseMessage: "Agent is ready for input",
      sessionTitle: "Fix the bug",
      messages: [
        { type: "user", text: "please fix\n the bug" },
        { type: "assistant", content: [{ type: "text", text: "first line\nlast line" }] },
      ],
    })
    expect(content.title).toBe("OpenCode · Fix the bug")
    expect(content.message).toBe("Agent is ready for input\nUser: please fix the bug\nAssistant: last line")
  })

  test("#given no messages #then the base message is used unchanged", () => {
    const content = buildIdleContent({ baseTitle: "T", baseMessage: "M", sessionTitle: "S", messages: [] })
    expect(content.title).toBe("T · S")
    expect(content.message).toBe("M")
  })
})

describe("helpers", () => {
  test("#given whitespace and permission hints #then V1 semantics hold", () => {
    expect(collapseWhitespace("a\n b\n\nc")).toBe("a b c")
    expect(getLastNonEmptyLine("a\n\n b")).toBe("b")
    expect(isPermissionHint("Do you allow this?")).toBe(true)
    expect(isPermissionHint("What color?")).toBe(false)
    expect(isActivityEvent("session.idle")).toBe(false)
    expect(isActivityEvent("session.text.delta")).toBe(true)
    // a long tool's streamed progress is activity
    expect(isActivityEvent("session.tool.progress")).toBe(true)
    // a tool terminal failure is activity
    expect(isActivityEvent("session.tool.failed")).toBe(true)
    // a message removal / revert cancels a pending idle notice
    expect(isActivityEvent("session.revert.staged")).toBe(true)
    expect(isActivityEvent("session.revert.cleared")).toBe(true)
    // the V1 names V2 never emits are not activity
    expect(isActivityEvent("message.updated")).toBe(false)
    expect(isActivityEvent("message.removed")).toBe(false)
  })

  test("#given a notification kind #then the sound name is platform-resolved by the host", () => {
    const config = { soundName: "chime" }
    expect(notificationSoundName(config, "idle")).toBe("chime")
    expect(notificationSoundName(config, "permission")).toBe("permission")
    expect(notificationSoundName(config, "question")).toBe("question")
  })
})

describe("isNotifiableSession", () => {
  test("#given a subagent session #then it is never notifiable", () => {
    expect(isNotifiableSession({ sessionID: "ses_child", rootSessionID: "ses_root", isChild: true, enforceMainSessionFilter: true })).toBe(false)
  })

  test("#given a non-root session with the filter on #then it is suppressed", () => {
    expect(isNotifiableSession({ sessionID: "ses_child", rootSessionID: "ses_root", isChild: false, enforceMainSessionFilter: true })).toBe(false)
  })

  test("#given the root session #then it is notifiable", () => {
    expect(isNotifiableSession({ sessionID: "ses_root", rootSessionID: "ses_root", isChild: false, enforceMainSessionFilter: true })).toBe(true)
  })
})

describe("createIdleScheduler", () => {
  const baseConfig = resolveNotificationConfig({ enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 0, skipIfIncompleteTodos: true })

  function build({ hasPendingWork = async () => false } = {}) {
    const clock = createClock()
    const emitted = []
    const logs = []
    const scheduler = createIdleScheduler({
      config: baseConfig,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      hasPendingWork,
      emitIdle: async (sessionID) => emitted.push(sessionID),
      onLog: (entry) => logs.push(entry),
    })
    return { clock, scheduler, emitted, logs }
  }

  test("#given an idle event #then the notification fires once after the delay", async () => {
    const { clock, scheduler, emitted } = build()
    scheduler.scheduleIdle("ses_1")
    await clock.advance(50)
    expect(emitted).toEqual([])
    await clock.advance(60)
    expect(emitted).toEqual(["ses_1"])
  })

  test("#given a second idle for the same session #then it is deduplicated", async () => {
    const { clock, scheduler, emitted } = build()
    scheduler.scheduleIdle("ses_1")
    await clock.advance(120)
    scheduler.scheduleIdle("ses_1")
    await clock.advance(120)
    expect(emitted).toEqual(["ses_1"])
  })

  test("#given activity before the delay #then the notification is cancelled", async () => {
    const { clock, scheduler, emitted } = build()
    scheduler.scheduleIdle("ses_1")
    await clock.advance(10)
    scheduler.markActivity("ses_1")
    await clock.advance(200)
    expect(emitted).toEqual([])
  })

  test("#given new activity after a notification #then a later idle notifies again", async () => {
    const { clock, scheduler, emitted } = build()
    scheduler.scheduleIdle("ses_1")
    await clock.advance(120)
    scheduler.markActivity("ses_1")
    scheduler.scheduleIdle("ses_1")
    await clock.advance(120)
    expect(emitted).toEqual(["ses_1", "ses_1"])
  })

  test("#given pending work #then the notification is suppressed and logged", async () => {
    const { clock, scheduler, emitted, logs } = build({ hasPendingWork: async () => true })
    scheduler.scheduleIdle("ses_1")
    await clock.advance(120)
    expect(emitted).toEqual([])
    expect(logs.some((entry) => entry.reason === "pending-work")).toBe(true)
  })

  test("#given a deleted session #then a later idle does not notify", async () => {
    const { clock, scheduler, emitted } = build()
    scheduler.scheduleIdle("ses_1")
    scheduler.deleteSession("ses_1")
    await clock.advance(200)
    expect(emitted).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  test("#given activity inside the grace window #then it is ignored", async () => {
    const clock = createClock()
    const emitted = []
    const config = resolveNotificationConfig({ enabled: true, idleConfirmationDelay: 100, activityGracePeriodMs: 30, skipIfIncompleteTodos: false })
    const scheduler = createIdleScheduler({
      config,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      emitIdle: async (sessionID) => emitted.push(sessionID),
    })
    scheduler.scheduleIdle("ses_1")
    await clock.advance(10)
    scheduler.markActivity("ses_1")
    await clock.advance(200)
    expect(emitted).toEqual(["ses_1"])
  })
})
