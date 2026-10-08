/**
 * Unit contract for the native V2 BTW CLI surface.
 *
 * Pins the `/btw` keymap command, the parent-session picker, side-session
 * creation through the V2 session API with the `omo_btw_side` metadata, the
 * double-escape interceptor wiring, the footer slot, and the headless no-op.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BTW_SIDE_METADATA_KEY } from "./rigel-v2-btw-core.mjs"
import {
  BTW_COMMAND_SLASH_NAME,
  BTW_FOOTER_SLOT_NAME,
  btwFooterLabel,
  buildCandidateParentOptions,
  createBtwCliSurface,
  currentBtwSessionID,
  resolveBtwSessionApi,
} from "./rigel-v2-native-cli-btw.mjs"

function fakeContext(opts = {}) {
  const sessions = opts.sessions ?? [
    { id: "ses_main", title: "Main", agent: "sisyphus", model: { providerID: "p", id: "m" }, time: { created: 1 } },
  ]
  const current = opts.current
  const handlers = new Map()
  const layers = []
  const intercepts = []
  const dialogCalls = []
  const toasts = []
  const created = []
  const routed = []
  const footerLabels = []
  const api = {
    renderer: "renderer" in opts ? opts.renderer : { isDestroyed: false, requestRender() {} },
    options: {},
    location: { current: { directory: "/tmp/work", ...(current ? { sessionID: current } : {}) } },
    data: {
      on(name, handler) {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
      session: {
        current: () => current,
        get: (id) => sessions.find((session) => session.id === id),
        list: () => sessions,
        message: { list: () => [{ info: { id: "msg_1", role: "user" } }] },
      },
    },
    v2: {
      session: {
        create: async (input) => {
          created.push(input)
          return { data: { id: "ses_new", title: input.title } }
        },
      },
    },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      dialog: { select: (spec) => dialogCalls.push(spec), clear() {}, open: false },
    },
    keymap: {
      layer(fn) {
        layers.push(fn)
        return () => {}
      },
      intercept(type, fn, options) {
        intercepts.push({ type, fn, options })
        return () => {}
      },
      clearPendingSequence() {},
    },
    prompt: { footer: { status: { set: (label) => footerLabels.push(label) } } },
    route: { navigate: (kind, args) => routed.push({ kind, args }) },
  }
  return { api, layers, intercepts, dialogCalls, toasts, created, routed, footerLabels, handlers }
}

let logDir
let logFile
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "rigel-cli-btw-"))
  logFile = join(logDir, "btw-cli.log")
})
afterEach(() => {
  rmSync(logDir, { recursive: true, force: true })
})

function deps(extra = {}) {
  return { logFile, ...extra }
}

function commandFrom(fake) {
  const layer = fake.layers[0]()
  return layer.commands[0]
}

describe("#given the BTW CLI surface", () => {
  test("#when the host has no renderer #then setup is a side-effect-free no-op", () => {
    // given
    const fake = fakeContext({ renderer: undefined })

    // when
    const dispose = createBtwCliSurface(deps()).setup(fake.api)

    // then
    expect(dispose).toBeUndefined()
    expect(fake.layers).toHaveLength(0)
    expect(fake.handlers.size).toBe(0)
  })

  test("#when setup runs #then it registers /btw, the escape interceptor, and the footer slot", () => {
    // given
    const fake = fakeContext({ current: "ses_main" })

    // when
    const dispose = createBtwCliSurface(deps()).setup(fake.api)

    // then
    expect(typeof dispose).toBe("function")
    const command = commandFrom(fake)
    expect(command.slash.name).toBe(BTW_COMMAND_SLASH_NAME)
    expect(command.slash.aliases).toContain("side")
    expect(fake.intercepts).toHaveLength(1)
    expect(fake.intercepts[0].type).toBe("key")
    expect(fake.footerLabels.length).toBeGreaterThanOrEqual(1)
    expect(() => dispose()).not.toThrow()
  })

  test("#when /btw runs #then the parent picker offers Main and New BTW", async () => {
    // given
    const fake = fakeContext({ current: "ses_main" })
    createBtwCliSurface(deps()).setup(fake.api)

    // when
    await commandFrom(fake).run()

    // then
    expect(fake.dialogCalls).toHaveLength(1)
    const values = fake.dialogCalls[0].options.map((option) => option.value)
    expect(values).toContain("session:ses_main")
    expect(values).toContain("new:ses_main")
  })

  test("#when New BTW is selected #then a side session is created with the metadata and the footer updates", async () => {
    // given
    const fake = fakeContext({ current: "ses_main" })
    createBtwCliSurface(deps()).setup(fake.api)
    await commandFrom(fake).run()

    // when
    await fake.dialogCalls[0].onSelect({ value: "new:ses_main" })

    // then
    expect(fake.created).toHaveLength(1)
    const metadata = fake.created[0].metadata[BTW_SIDE_METADATA_KEY]
    expect(metadata).toEqual({ version: 1, parent_session_id: "ses_main", boundary_message_id: "msg_1" })
    expect(fake.created[0].agent).toBe("sisyphus")
    expect(fake.footerLabels.at(-1)).toContain("ses_new")
    expect(fake.routed.some((entry) => entry.args.sessionID === "ses_new")).toBe(true)
  })

  test("#when an existing session is selected #then it navigates without creating a side", async () => {
    // given
    const fake = fakeContext({ current: "ses_main" })
    createBtwCliSurface(deps()).setup(fake.api)
    await commandFrom(fake).run()

    // when
    await fake.dialogCalls[0].onSelect({ value: "session:ses_main" })

    // then
    expect(fake.created).toHaveLength(0)
    expect(fake.routed.at(-1)).toEqual({ kind: "session", args: { sessionID: "ses_main" } })
  })

  test("#when there is no current session #then the command warns instead of opening a picker", async () => {
    // given
    const fake = fakeContext({ current: undefined })
    const surface = createBtwCliSurface(deps({ getCurrentSessionID: () => undefined }))
    surface.setup(fake.api)

    // when
    await commandFrom(fake).run()

    // then
    expect(fake.dialogCalls).toHaveLength(0)
    expect(fake.toasts.at(-1).variant).toBe("warning")
  })

  test("#when the V2 session API is absent #then the start degrades to a logged toast", async () => {
    // given
    const fake = fakeContext({ current: "ses_main" })
    delete fake.api.v2.session
    createBtwCliSurface(deps()).setup(fake.api)
    await commandFrom(fake).run()

    // when
    const selected = await fake.dialogCalls[0].onSelect({ value: "new:ses_main" })

    // then
    expect(selected).toBeUndefined()
    expect(fake.created).toHaveLength(0)
    expect(fake.toasts.some((toast) => toast.message.includes("Unable to start BTW"))).toBe(true)
  })
})

describe("#given the BTW CLI helper exports", () => {
  test("#then the footer label reflects the controller phase", () => {
    expect(btwFooterLabel({ phase: "closed" })).toBe("")
    expect(btwFooterLabel({ phase: "creating" })).toBe("BTW starting...")
    expect(btwFooterLabel({ phase: "open", sideSessionID: "ses_side" })).toContain("ses_side")
  })

  test("#then candidate parent options mark the current parent", () => {
    const { options, current } = buildCandidateParentOptions([{ id: "ses_a", title: "A" }, { id: "ses_b", title: "B" }], "ses_b")
    expect(options.map((option) => option.value)).toEqual(["session:ses_a", "session:ses_b"])
    expect(current).toBe("session:ses_b")
    expect(buildCandidateParentOptions([], "x").options[0].disabled).toBe(true)
  })

  test("#then the session API resolver prefers the V2 session surface", () => {
    const v2 = { create() {} }
    const data = { get() {} }
    expect(resolveBtwSessionApi({ v2: { session: v2 }, data: { session: data } })).toBe(v2)
    expect(resolveBtwSessionApi({ data: { session: data } })).toBeUndefined()
  })

  test("#then the current session id resolves across context shapes", () => {
    expect(currentBtwSessionID({ data: { session: { current: () => "ses_1" } } })).toBe("ses_1")
    expect(currentBtwSessionID({ location: { current: { sessionID: "ses_2" } } })).toBe("ses_2")
    expect(currentBtwSessionID({})).toBeUndefined()
  })

  test("#then the footer slot name is the documented V2 slot", () => {
    expect(BTW_FOOTER_SLOT_NAME).toBe("prompt.footer.status")
  })
})
