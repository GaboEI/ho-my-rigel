/**
 * Runtime bridge from OmO's legacy `{ id, server }` plugin contract to the
 * OpenCode V2 setup() API exposed by the V2 plugin host.
 *
 * This deliberately lives outside the OmO bundle for now: V2 cannot add
 * agents during setup(), so agents are materialized statically while this
 * bridge ports the runtime tools and lifecycle hooks.
 */

const fallbackClient = {
  app: { log: async () => undefined, agents: async () => ({ data: [] }) },
  session: { messages: async () => ({ data: [] }) },
  // OpenCode V2's setup context does not expose the V1 TUI RPC client. OmO
  // treats notifications as best effort, so preserve execution and omit the
  // unavailable visual toast instead of fabricating a UI side effect.
  tui: { showToast: async () => undefined },
}

const supportedLegacyHooks = new Set([
  "tool",
  "tool.execute.before",
  "tool.execute.after",
  "chat.message",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
])

export function createRigelV2Plugin({ id = "ho-my-rigel", loadLegacyHooks }) {
  if (typeof loadLegacyHooks !== "function") throw new TypeError("loadLegacyHooks debe ser una función")

  return {
    id,
    setup: async (context) => {
      const directory = context?.location?.directory ?? process.cwd()
      const client = adaptLegacyClient(context?.client, directory)
      const serverUrl = context?.serverUrl ?? new URL("http://127.0.0.1:4096")
      const legacy = await loadLegacyHooks({ directory, client, serverUrl, $: context?.$ })
      const registrations = []

      await registerTools(context, legacy, directory, registrations)
      await registerToolHooks(context, legacy, registrations)
      await registerSessionHooks(context, legacy, registrations)

      const unsupported = Object.keys(legacy)
        .filter((name) => !supportedLegacyHooks.has(name) && name !== "dispose")
        .sort()
      console.error(
        `[${id}] OpenCode V2 bridge active: ${Object.keys(legacy.tool ?? {}).length} tools; ` +
        `${registrations.length} registrations; unsupported legacy hooks: ${unsupported.join(", ") || "none"}`,
      )

      return async () => {
        const results = await Promise.allSettled(registrations.map((registration) => registration.dispose?.()))
        const failures = results.filter((result) => result.status === "rejected")
        await legacy.dispose?.()
        if (failures.length > 0) {
          throw new AggregateError(failures.map((result) => result.reason), "No se pudieron liberar todos los registros V2")
        }
      }
    },
  }
}

async function registerTools(context, legacy, directory, registrations) {
  if (!legacy.tool || typeof context?.tool?.transform !== "function") return
  registrations.push(await context.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(legacy.tool)) {
      editor.add({
        name,
        description: definition.description,
        // OmO's definitions already carry a Zod raw shape. V2 accepts that
        // shape directly, which avoids importing a machine-specific Zod path.
        input: definition.args,
        execute: async (input, toolContext) => normalizeToolResult(await definition.execute(input, {
          sessionID: toolContext.sessionID,
          messageID: toolContext.messageID,
          agent: toolContext.agent,
          directory,
          // V2 hands these over and the legacy context expects them: without
          // `ask` the skill tool throws, and without `client` the delegate
          // task cannot resolve agents.
          worktree: toolContext.worktree,
          abort: toolContext.signal,
          // V2 declares `ask` on ToolContext but does not populate it for tools
          // registered through the tool editor, so forwarding alone yields
          // undefined and the skill tool throws. Forward it when present and
          // fall back to a permissive resolver so a missing host permission
          // callback can never hard-fail a tool call.
          ask: typeof toolContext.ask === "function" ? toolContext.ask : async () => {},
          client: adaptLegacyClient(context?.client, directory),
          metadata: (metadata) => { void toolContext.progress?.(metadata) },
        })),
      })
    }
  }))
}

/**
 * OmO's task tool asks for the V1 endpoint `client.app.agents()`.  OpenCode
 * V2 exposes the same data as `client.agent.list({ location })`.  Keep all
 * other client surfaces native and bridge only this renamed endpoint.
 */
function adaptLegacyClient(client, directory) {
  if (!client || typeof client !== "object") return fallbackClient
  if (typeof client?.app?.agents === "function") return client

  const app = {
    ...(client.app && typeof client.app === "object" ? client.app : {}),
    log: typeof client?.app?.log === "function" ? client.app.log.bind(client.app) : fallbackClient.app.log,
    agents: async (input = {}) => {
      if (typeof client?.agent?.list !== "function") return fallbackClient.app.agents()
      const location = {
        directory: typeof input?.directory === "string" ? input.directory : directory,
        ...(typeof input?.workspace === "string" ? { workspace: input.workspace } : {}),
      }
      return client.agent.list({ location })
    },
  }

  // A proxy preserves getters/methods of the generated SDK with `client` as
  // their receiver; Object.create(client) would break SDK private fields.
  return new Proxy(client, {
    get(target, property) {
      if (property === "app") return app
      return Reflect.get(target, property, target)
    },
  })
}

async function registerToolHooks(context, legacy, registrations) {
  if (typeof context?.tool?.hook !== "function") return
  if (typeof legacy["tool.execute.before"] === "function") {
    registrations.push(await context.tool.hook("execute.before", async (input) => {
      await legacy["tool.execute.before"](
        { tool: input.tool, sessionID: input.sessionID, callID: input.id },
        { args: input.input },
      )
    }))
  }
  if (typeof legacy["tool.execute.after"] === "function") {
    registrations.push(await context.tool.hook("execute.after", async (input) => {
      if (input.status !== "completed") return
      const result = input.result ?? {}
      await legacy["tool.execute.after"](
        { tool: input.tool, sessionID: input.sessionID, callID: input.id, args: input.input },
        {
          title: String(result.metadata?.title ?? input.tool),
          output: toolOutputToText(result),
          metadata: result.metadata ?? {},
        },
      )
    }))
  }
}

async function registerSessionHooks(context, legacy, registrations) {
  if (typeof context?.session?.hook !== "function") return
  if (typeof legacy["chat.message"] === "function") {
    registrations.push(await context.session.hook("prompt", async (input) => {
      const text = extractText(input.prompt)
      if (!text) return
      await legacy["chat.message"](
        { sessionID: input.sessionID, messageID: input.messageID },
        { message: input.prompt, parts: [{ type: "text", text }] },
      )
    }))
  }
  if (typeof legacy["experimental.chat.system.transform"] === "function") {
    registrations.push(await context.session.hook("context", async (input) => {
      const original = (input.system ?? []).map((part) => part.text)
      const output = { system: [...original] }
      await legacy["experimental.chat.system.transform"](
        { sessionID: input.sessionID, model: input.model },
        output,
      )
      const additions = insertedStrings(original, output.system)
      if (additions.length > 0) input.system.splice(1, 0, ...additions.map((text) => ({ type: "text", text })))
    }))
  }
  if (typeof legacy["experimental.session.compacting"] === "function") {
    registrations.push(await context.session.hook("compaction", async (input) => {
      const output = { context: [] }
      await legacy["experimental.session.compacting"]({ sessionID: input.sessionID }, output)
      if (output.context.length > 0) input.result = { summary: output.context.join("\n\n") }
    }))
  }
}

function normalizeToolResult(result) {
  if (typeof result === "string") return { content: result }
  if (result && typeof result === "object") {
    return {
      content: result.output ?? "",
      metadata: { ...(result.metadata ?? {}), ...(result.title ? { title: result.title } : {}) },
    }
  }
  return { content: String(result ?? "") }
}

function toolOutputToText(result) {
  if (typeof result.content === "string") return result.content
  if (Array.isArray(result.content)) {
    return result.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
  }
  return JSON.stringify(result.output ?? "")
}

function insertedStrings(original, transformed) {
  const additions = []
  let index = 0
  for (const value of transformed) {
    if (index < original.length && value === original[index]) index += 1
    else additions.push(value)
  }
  return additions
}

function extractText(value, depth = 0) {
  if (depth > 6 || value == null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join("\n")
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text
    if (value.content !== undefined) return extractText(value.content, depth + 1)
    if (value.parts !== undefined) return extractText(value.parts, depth + 1)
  }
  return ""
}
