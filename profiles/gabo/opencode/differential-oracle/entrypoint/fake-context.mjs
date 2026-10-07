/**
 * Fake OpenCode V2 setup context.
 *
 * This drives the FULL plugin
 * entrypoint (`rigel-v2-native.mjs` default export `setup(ctx)`), not a helper,
 * and observe the effects the entrypoint produces for handoff, recovery and
 * compaction. This module builds the minimal V2 context that the real `setup`
 * consumes and records every registration and host call it makes, so a scenario
 * can trigger the registered hooks / event loop and read the observable back.
 *
 * Boundary: the context is inert data. `location.directory` and every state
 * root the driver isolates point at throwaway temp dirs; no V1 path is read and
 * no `context.mcp` / real `context.skill` inventory is reachable here.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf8")
}

/**
 * Deterministic event feed. The async generator blocks until an event is
 * pushed; `consumed()` resolves AFTER the runtime processed the yielded event,
 * so a scenario synchronizes on the loop advancing instead of sleeping. The
 * abort signal (from the plugin's dispose) ends the generator.
 */
export function createEventFeed() {
  const queue = []
  let notify
  let onConsumed
  let abortSignal
  const events = {
    async *[Symbol.asyncIterator]() {
      while (!abortSignal?.aborted) {
        while (queue.length === 0) {
          if (abortSignal?.aborted) return
          await new Promise((resolve) => {
            notify = resolve
            abortSignal?.addEventListener("abort", resolve, { once: true })
          })
        }
        if (abortSignal?.aborted) return
        yield queue.shift()
        const consumed = onConsumed
        onConsumed = undefined
        consumed?.()
      }
    },
  }
  return {
    events,
    subscribe: ({ signal } = {}) => { abortSignal = signal; return events },
    push(event) {
      queue.push(event)
      const resolve = notify
      notify = undefined
      resolve?.()
    },
    consumed() {
      return new Promise((resolve) => { onConsumed = resolve })
    },
  }
}

/** In-memory V2 storage domain (never touches disk, never V1 state). */
export function memoryStorage() {
  const map = new Map()
  return {
    async get(key) { return map.get(key) },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
  }
}

/**
 * Build the fake V2 context and the capture object the drivers read.
 *
 * @param {{
 *   directory?: string,
 *   config?: object,
 *   agents?: object[],
 *   models?: object[],
 *   childTranscript?: unknown[],
 *   sessionAgent?: string,
 *   withSkill?: boolean,
 *   withMcp?: boolean,
 *   skillsHome?: string,
 *   skillsEnv?: object,
 * }} [options]
 */
export function createEntrypointContext(options = {}) {
  const directory = options.directory ?? tempDir("diff-entrypoint-")
  const feed = createEventFeed()
  const storage = memoryStorage()
  const capture = {
    prompts: [],
    creates: [],
    contextReads: [],
    compactCalls: [],
    switchModelCalls: [],
    sessionHooks: [],
    toolHooks: [],
    tools: new Map(),
    commands: new Map(),
    skillTransforms: 0,
    mcpTransforms: 0,
    agentTransforms: 0,
    agentReloads: 0,
  }
  const recordSession = (name, handler) => {
    const registration = { name, handler, disposed: false, dispose() { registration.disposed = true } }
    capture.sessionHooks.push(registration)
    return registration
  }
  const recordTool = (name, handler) => {
    const registration = { name, handler, disposed: false, dispose() { registration.disposed = true } }
    capture.toolHooks.push(registration)
    return registration
  }

  const context = {
    location: { directory },
    app: options.app,
    config: options.config ?? {},
    options: {
      skillsHome: options.skillsHome,
      skillsEnv: options.skillsEnv,
      tmuxVizEnv: options.skillsEnv,
    },
    agent: {
      list: async () => ({ data: options.agents ?? [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async (callback) => {
        capture.agentTransforms += 1
        callback({
          // The runtime registers each agent through `editor.update(id, apply)`;
          // `apply` must run so `onAgentPermissions` receives the translated
          // gates. Invoke it with a mutable agent stub.
          update(id, apply) { if (typeof apply === "function") apply({ id }) },
          default() {},
        })
        return { dispose() {} }
      },
      reload: async () => { capture.agentReloads += 1 },
    },
    model: {
      list: async () => ({
        data: options.models ?? [
          { providerID: "opencode-go", id: "kimi-k3", enabled: true },
          { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
        ],
      }),
    },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => recordSession(name, handler),
      create: async (input) => { capture.creates.push(input); return { data: { id: options.childSessionID ?? "ses_entrypoint_child" } } },
      prompt: async (input) => {
        capture.prompts.push(input)
        options.onPrompt?.(input)
        return { data: {} }
      },
      context: async (input) => { capture.contextReads.push(input); return options.childTranscript ?? [] },
      wait: async () => ({}),
      compact: async (input) => { capture.compactCalls.push(input); return {} },
      switchModel: async (input) => { capture.switchModelCalls.push(input); return {} },
      list: async () => ({ data: [] }),
      get: async () => ({ data: { agent: options.sessionAgent } }),
      status: async () => ({ data: [] }),
    },
    tool: {
      transform: async (callback) => {
        callback({
          add: (definition) => { if (definition?.name) capture.tools.set(definition.name, definition) },
          get: (name) => capture.tools.get(name),
          update() {},
          default() {},
        })
        return { dispose() {} }
      },
      hook: async (name, handler) => recordTool(name, handler),
    },
    command: {
      transform: async (callback) => {
        callback({
          add: (definition) => { if (definition?.name) capture.commands.set(definition.name, definition) },
          get: () => undefined,
          update() {},
          default() {},
        })
        return { dispose() {} }
      },
      list: async () => ({}),
    },
    storage,
  }

  if (options.withSkill) {
    context.skill = {
      transform: async (callback) => {
        capture.skillTransforms += 1
        callback({ add() {}, get: () => undefined })
        return { dispose() {} }
      },
      list: async () => ({ data: [] }),
    }
  }
  if (options.withMcp) {
    context.mcp = {
      transform: async (callback) => {
        capture.mcpTransforms += 1
        callback({ get: () => undefined, set() {} })
        return { dispose() {} }
      },
      list: async () => ({ data: [] }),
    }
  }

  return { context, capture, feed, directory, storage }
}

/** Session-hook registrations by name, in registration order. */
export function hooksNamed(capture, name) {
  return capture.sessionHooks.filter((registration) => registration.name === name)
}

/** Tool-hook registrations by name, in registration order. */
export function toolHooksNamed(capture, name) {
  return capture.toolHooks.filter((registration) => registration.name === name)
}

/** Text of a message content that may be a string or an array of parts. */
export function messageText(message) {
  if (typeof message?.content === "string") return message.content
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
  }
  return ""
}
