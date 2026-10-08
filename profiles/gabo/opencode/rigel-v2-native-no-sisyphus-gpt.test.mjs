import { test, expect } from "bun:test"
import {
  HEPHAESTUS_UNAVAILABLE_TOAST_MESSAGE,
  TOAST_MESSAGE,
  createNativeNoSisyphusGptEnforcement,
  decideNoSisyphusGpt,
  isGpt6Model,
  isGptModel,
  isGptNativeSisyphusModel,
} from "./rigel-v2-native-no-sisyphus-gpt.mjs"

// Upstream 5fd04b590: keep Sisyphus when Hephaestus is not registered.

test("the GPT detectors mirror the V1 owners", () => {
  expect(isGptModel("openai/gpt-4o")).toBe(true)
  expect(isGptModel("anthropic/claude-opus-5-5")).toBe(false)
  expect(isGptNativeSisyphusModel("gpt-5.5")).toBe(true)
  expect(isGptNativeSisyphusModel("gpt-5-codex")).toBe(true)
  expect(isGptNativeSisyphusModel("gpt-4o")).toBe(false)
  expect(isGpt6Model("gpt-6-sol")).toBe(true)
  expect(isGpt6Model("gpt-5.6-sol")).toBe(false)
})

test("a non-Sisyphus agent or a supported GPT/6 model is a no-op", () => {
  expect(decideNoSisyphusGpt({ agent: "hephaestus", modelID: "gpt-4o", hephaestusAvailable: true }).action).toBe("none")
  expect(decideNoSisyphusGpt({ agent: "sisyphus", modelID: undefined, hephaestusAvailable: true }).action).toBe("none")
  expect(decideNoSisyphusGpt({ agent: "sisyphus", modelID: "gpt-5.5", hephaestusAvailable: true }).action).toBe("none")
  expect(decideNoSisyphusGpt({ agent: "sisyphus", modelID: "gpt-6-sol", hephaestusAvailable: true }).action).toBe("none")
  expect(decideNoSisyphusGpt({ agent: "sisyphus", modelID: "claude-opus-5-5", hephaestusAvailable: true }).action).toBe("none")
})

test("an unsupported GPT model redirects when Hephaestus is registered", () => {
  const decision = decideNoSisyphusGpt({ agent: "Sisyphus - ultraworker", modelID: "openai/gpt-4o", hephaestusAvailable: true })
  expect(decision.action).toBe("redirect")
  expect(decision.message).toBe(TOAST_MESSAGE)
})

test("an unsupported GPT model is kept (no switch) when Hephaestus is not registered", () => {
  const decision = decideNoSisyphusGpt({ agent: "sisyphus", modelID: "gpt-4o", hephaestusAvailable: false })
  expect(decision.action).toBe("keep")
  expect(decision.message).toBe(HEPHAESTUS_UNAVAILABLE_TOAST_MESSAGE)
})

test("the enforcement switches the session agent to the registered Hephaestus name, notifies, and guards once per session", async () => {
  const switches = []
  const notices = []
  const logs = []
  const enforcement = createNativeNoSisyphusGptEnforcement({
    switchAgent: async (args) => { switches.push(args) },
    notify: (payload) => { notices.push(payload) },
    hephaestusTarget: () => "Hephaestus - Deep Agent",
    log: (message, detail) => { logs.push({ message, detail }) },
  })
  const event = { sessionID: "ses_1", agent: "Sisyphus", model: { providerID: "openai", modelID: "gpt-4o" } }
  const first = await enforcement.handle(event)
  const second = await enforcement.handle(event)
  expect(first.action).toBe("redirect")
  expect(switches).toEqual([{ sessionID: "ses_1", agent: "Hephaestus - Deep Agent" }])
  expect(notices).toEqual([{ sessionID: "ses_1", message: TOAST_MESSAGE, variant: "error" }])
  expect(logs.length).toBe(1)
  expect(second.alreadyHandled).toBe(true)
  enforcement.clear("ses_1")
  await enforcement.handle(event)
  expect(switches.length).toBe(2)
})

test("the enforcement keeps Sisyphus and notifies without switching when Hephaestus is not registered", async () => {
  const switches = []
  const notices = []
  const enforcement = createNativeNoSisyphusGptEnforcement({
    switchAgent: async (args) => { switches.push(args) },
    notify: (payload) => { notices.push(payload) },
    hephaestusTarget: () => undefined,
    log: () => {},
  })
  const decision = await enforcement.handle({ sessionID: "ses_2", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(decision.action).toBe("keep")
  expect(switches).toEqual([])
  expect(notices).toEqual([{ sessionID: "ses_2", message: HEPHAESTUS_UNAVAILABLE_TOAST_MESSAGE, variant: "error" }])
})

test("a switchAgent failure still notifies and logs (never a silent no-op)", async () => {
  const notices = []
  const logs = []
  const enforcement = createNativeNoSisyphusGptEnforcement({
    switchAgent: async () => { throw new Error("switch unavailable") },
    notify: (payload) => { notices.push(payload) },
    hephaestusTarget: () => "Hephaestus - Deep Agent",
    log: (message) => { logs.push(message) },
  })
  const decision = await enforcement.handle({ sessionID: "ses_3", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(decision.action).toBe("redirect")
  expect(notices.length).toBe(1)
  expect(logs.some((line) => line.includes("switchAgent failed"))).toBe(true)
})

// Auditoría: el switch solo se reporta `switched:true` y se marca manejado tras
// un switch CONFIRMADO. Un fallo debe ser observable, no mentir sobre el estado
// ni bloquear un reintento seguro; el aviso async debe quedar contenido.

test("a synchronous switchAgent throw reports switched:false and does not mark the session handled (a later prompt retries)", async () => {
  const logs = []
  let switchCalls = 0
  const enforcement = createNativeNoSisyphusGptEnforcement({
    switchAgent: () => { switchCalls += 1; throw new Error("sync switch failure") },
    notify: () => {},
    hephaestusTarget: () => "Hephaestus - Deep Agent",
    log: (message, detail) => { logs.push({ message, detail }) },
  })
  const first = await enforcement.handle({ sessionID: "ses_sync", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(first.action).toBe("redirect")
  expect(first.switched).toBe(false)
  expect(first.failed).toBe(true)
  expect(first.error).toBe("sync switch failure")
  const failureLog = logs.find((line) => line.message.includes("switchAgent failed"))
  expect(failureLog.detail.switched).toBe(false)
  expect(failureLog.detail.failed).toBe(true)
  // not marked handled: a later prompt retries the switch instead of staying on GPT
  const second = await enforcement.handle({ sessionID: "ses_sync", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(second.alreadyHandled).toBeUndefined()
  expect(switchCalls).toBe(2)
})

test("an async switchAgent rejection is caught, reported as switched:false, and retried", async () => {
  const enforcement = createNativeNoSisyphusGptEnforcement({
    switchAgent: async () => { throw new Error("async switch failure") },
    notify: () => {},
    hephaestusTarget: () => "Hephaestus - Deep Agent",
    log: () => {},
  })
  const first = await enforcement.handle({ sessionID: "ses_async", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(first).toMatchObject({ action: "redirect", switched: false, failed: true, error: "async switch failure" })
  const second = await enforcement.handle({ sessionID: "ses_async", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(second.alreadyHandled).toBeUndefined()
})

test("a confirmed switch reports switched:true, marks handled, and the notice is not lost", async () => {
  const switches = []
  const notices = []
  const enforcement = createNativeNoSisyphusGptEnforcement({
    switchAgent: async (args) => { switches.push(args) },
    notify: async (payload) => { notices.push(payload) },
    hephaestusTarget: () => "Hephaestus - Deep Agent",
    log: () => {},
  })
  const decision = await enforcement.handle({ sessionID: "ses_ok", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(decision).toMatchObject({ action: "redirect", switched: true })
  expect(switches).toEqual([{ sessionID: "ses_ok", agent: "Hephaestus - Deep Agent" }])
  expect(notices.length).toBe(1)
  expect((await enforcement.handle({ sessionID: "ses_ok", agent: "sisyphus", model: { modelID: "gpt-4o" } })).alreadyHandled).toBe(true)
})

test("a rejected async notify is contained and logged, and the redirect is still handled", async () => {
  const logs = []
  const enforcement = createNativeNoSisyphusGptEnforcement({
    switchAgent: async () => {},
    notify: async () => { throw new Error("notify boom") },
    hephaestusTarget: () => "Hephaestus - Deep Agent",
    log: (message, detail) => { logs.push({ message, detail }) },
  })
  const decision = await enforcement.handle({ sessionID: "ses_notify", agent: "sisyphus", model: { modelID: "gpt-4o" } })
  expect(decision).toMatchObject({ action: "redirect", switched: true })
  expect(logs.some((line) => line.message.includes("notify failed") && line.detail.error === "notify boom")).toBe(true)
})
