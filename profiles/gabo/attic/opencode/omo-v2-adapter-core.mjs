/**
 * Runtime bridge from OmO's legacy `{ id, server }` plugin contract to the
 * OpenCode V2 setup() API exposed by the V2 plugin host.
 *
 * This deliberately lives outside the OmO bundle for now. The native Rigel
 * runtime owns agent registration through V2's AgentEditor; this bridge ports
 * only the remaining V1 runtime tools and lifecycle hooks.
 */

const fallbackClient = {
  app: { log: async () => undefined },
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
])

export function createRigelV2Plugin({ id = "oh-my-rigel", loadLegacyHooks, serializeLegacyArgs }) {
  if (typeof loadLegacyHooks !== "function") throw new TypeError("loadLegacyHooks debe ser una función")

  return {
    id,
    setup: async (context) => {
      const directory = context?.location?.directory ?? process.cwd()
      const client = adaptLegacyClient(context, directory)
      const serverUrl = context?.serverUrl ?? new URL("http://127.0.0.1:4096")
      const legacy = await loadLegacyHooks({ directory, client, serverUrl, $: context?.$ })
      const registrations = []

      await registerTools(context, legacy, directory, serializeLegacyArgs, registrations)
      await registerToolHooks(context, legacy, registrations)
      await registerSessionHooks(context, legacy, registrations)

      const unsupported = Object.keys(legacy)
        .filter((name) => !supportedLegacyHooks.has(name) && name !== "dispose")
        .sort()
      console.error(
        `[${id}] OpenCode V2 bridge active: ${Object.keys(legacy.tool ?? {}).length} tools; ` +
        `${registrations.length} registrations; native V2 agent/session facade; ` +
        `unsupported legacy hooks: ${unsupported.join(", ") || "none"}`,
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

async function registerTools(context, legacy, directory, serializeLegacyArgs, registrations) {
  if (!legacy.tool || typeof context?.tool?.transform !== "function") return
  registrations.push(await context.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(legacy.tool)) {
      editor.add({
        name,
        // V2 otherwise classifies the legacy tool as code-mode only and
        // removes it from ordinary model requests. A registered-but-hidden
        // tool is not a migrated tool.
        options: { codemode: false },
        description: definition.description,
        // V2 requires one Standard Schema or JSON Schema document, never the
        // V1 raw `{ field: ZodSchema }` shape. Each OmO Zod v4 field can emit
        // its own JSON Schema, so the bridge needs no second Zod installation.
        input: legacyArgsToJsonSchema(name, definition.args, serializeLegacyArgs),
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
          client: adaptLegacyClient(context, directory),
          metadata: (metadata) => { void toolContext.progress?.(metadata) },
        })),
      })
    }
  }))
}

export function legacyArgsToJsonSchema(toolName, args, serializeLegacyArgs) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError(`Legacy tool "${toolName}" has no object argument shape`)
  }
  if (typeof serializeLegacyArgs === "function") {
    let jsonSchema
    try { jsonSchema = serializeLegacyArgs(args) } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new TypeError(`Legacy tool "${toolName}" JSON Schema conversion failed: ${detail}`)
    }
    if (!jsonSchema || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
      throw new TypeError(`Legacy tool "${toolName}" emitted an invalid root JSON Schema`)
    }
    return stripJsonSchemaRoot(jsonSchema)
  }
  const properties = {}
  const required = []
  for (const [name, schema] of Object.entries(args)) {
    if (typeof schema?.toJSONSchema !== "function" && typeof schema?._zod?.toJSONSchema !== "function") {
      throw new TypeError(`Legacy tool "${toolName}" argument "${name}" cannot emit JSON Schema`)
    }
    let jsonSchema
    try {
      jsonSchema = typeof schema.toJSONSchema === "function"
        ? schema.toJSONSchema()
        : schema._zod.toJSONSchema()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new TypeError(`Legacy tool "${toolName}" argument "${name}" JSON Schema conversion failed: ${detail}`)
    }
    if (!jsonSchema || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
      throw new TypeError(`Legacy tool "${toolName}" argument "${name}" emitted an invalid JSON Schema`)
    }
    properties[name] = stripJsonSchemaRoot(jsonSchema)
    if (!isOptionalSchema(schema)) required.push(name)
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function isOptionalSchema(schema) {
  try { return typeof schema?.isOptional === "function" && schema.isOptional() } catch { return false }
}

function stripJsonSchemaRoot(jsonSchema) {
  const { $schema: _schema, ...rest } = jsonSchema
  return rest
}

/**
 * OmO's V1 tools expect an SDK client. V2 hands the plugin setup context to
 * `setup()` directly. This is a narrow V1-shaped facade over the live V2
 * domains: `agent.list` supplies the current inventory and `session` creates
 * and prompts real child sessions. No JSON config is read here: a disk copy
 * is precisely the stale inventory that made V2 delegation misleading.
 */
function adaptLegacyClient(context, directory) {
  const client = context?.client && typeof context.client === "object" ? context.client : {}
  const nativeAgent = context?.agent
  const nativeSession = context?.session
  const app = {
    ...(client.app && typeof client.app === "object" ? client.app : {}),
    log: typeof client?.app?.log === "function" ? client.app.log.bind(client.app) : fallbackClient.app.log,
    agents: async (input = {}) => {
      const location = {
        directory: typeof input?.directory === "string" ? input.directory : directory,
        ...(typeof input?.workspace === "string" ? { workspace: input.workspace } : {}),
      }
      // V1 exposed this globally. V2 scopes it to a location. Passing the
      // location to both possible host surfaces makes the legacy call
      // deterministic instead of silently receiving an empty workspace list.
      const hostResult = normalizeAgentInventory(await readAgentInventory(nativeAgent?.list, nativeAgent, { location }))
      if (hasCallableAgents(hostResult)) return logAgentInventory("context.agent.list", hostResult)
      const v2Result = normalizeAgentInventory(await readAgentInventory(client?.agent?.list, client.agent, { location }))
      if (hasCallableAgents(v2Result)) return logAgentInventory("client.agent.list", v2Result)
      // A malformed or unavailable answer is not an inventory. Preserve the
      // V1 return shape but never substitute a static file as false truth.
      console.error("[oh-my-rigel] V2 agent inventory unavailable from context.agent.list")
      return { data: [] }
    },
  }
  const session = legacySessionFacade(nativeSession, client?.session)

  // Preserve any SDK methods V2 happens to expose, while overriding the two
  // V1 namespaces that must be translated to the native V2 domains.
  return new Proxy(client, {
    get(target, property) {
      if (property === "app") return app
      if (property === "session") return session
      // Several V1 hooks notify best-effort through the TUI during ordinary
      // chat.message processing. V2 setup contexts do not provide that RPC;
      // return the explicit no-op facade rather than exposing `undefined` and
      // aborting the entire provider turn on a cosmetic notification.
      if (property === "tui") {
        return target?.tui && typeof target.tui === "object" ? target.tui : fallbackClient.tui
      }
      return Reflect.get(target, property, target)
    },
  })
}

function legacySessionFacade(nativeSession, sdkSession) {
  const native = nativeSession && typeof nativeSession === "object" ? nativeSession : undefined
  const unavailable = (name) => async () => {
    throw new Error(`OpenCode V2 session.${name} is unavailable from the plugin context`)
  }
  const sessionID = (input) => input?.sessionID ?? input?.path?.id
  const body = (input) => input?.body && typeof input.body === "object" ? input.body : {}
  return {
    ...(sdkSession && typeof sdkSession === "object" ? sdkSession : {}),
    get: typeof native?.get === "function"
      ? async (input = {}) => ({ data: await native.get({ sessionID: sessionID(input) }) })
      : typeof sdkSession?.get === "function" ? sdkSession.get.bind(sdkSession) : unavailable("get"),
    create: typeof native?.create === "function"
      ? async (input = {}) => ({ data: await native.create({
        ...body(input),
        ...(input?.query?.directory ? { location: { directory: input.query.directory } } : {}),
      }) })
      : typeof sdkSession?.create === "function" ? sdkSession.create.bind(sdkSession) : unavailable("create"),
    prompt: typeof native?.prompt === "function"
      ? async (input = {}) => {
        const request = body(input)
        const text = extractText(request.parts) || request.text
        return { data: await native.prompt({
          ...request,
          sessionID: sessionID(input),
          ...(typeof text === "string" ? { text } : {}),
          resume: request.resume ?? true,
        }) }
      }
      : typeof sdkSession?.prompt === "function" ? sdkSession.prompt.bind(sdkSession) : unavailable("prompt"),
    wait: typeof native?.wait === "function"
      ? async (input = {}) => ({ data: await native.wait({ ...input, sessionID: sessionID(input) }) })
      : typeof sdkSession?.wait === "function" ? sdkSession.wait.bind(sdkSession) : unavailable("wait"),
    messages: typeof sdkSession?.messages === "function" ? sdkSession.messages.bind(sdkSession) : unavailable("messages"),
  }
}

async function readAgentInventory(method, receiver, input) {
  if (typeof method !== "function") return undefined
  try { return await method.call(receiver, input) } catch { return undefined }
}

function normalizeAgentInventory(result) {
  const data = Array.isArray(result) ? result : (result?.data ?? result?.agents)
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const nested = entry.agent && typeof entry.agent === "object" ? entry.agent : {}
    const name = entry.name ?? entry.id ?? nested.name ?? nested.id
    const mode = entry.mode ?? nested.mode ?? entry.config?.mode ?? nested.config?.mode
    if (typeof name !== "string" || typeof mode !== "string") return []
    return [{
      name,
      mode,
      ...(entry.hidden ?? nested.hidden ? { hidden: true } : {}),
      ...(typeof entry.model === "string" ? { model: entry.model } : {}),
    }]
  })
}

function hasCallableAgents(agents) {
  return agents.some((agent) => (agent.mode === "subagent" || agent.mode === "all") && !agent.hidden)
}

function logAgentInventory(source, agents) {
  const callable = agents.filter((agent) => (agent.mode === "subagent" || agent.mode === "all") && !agent.hidden).length
  console.error(`[oh-my-rigel] V2 agent inventory: ${source}, ${callable} callable agents`)
  return { data: agents }
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
  const hasChatMessage = typeof legacy["chat.message"] === "function"
  const hasSystemTransform = typeof legacy["experimental.chat.system.transform"] === "function"
  if (hasChatMessage || hasSystemTransform) {
    registrations.push(await context.session.hook("http.request", async (input) => {
      if (input?.kind !== "primary") return
      let body
      try { body = await input.request.clone().json() } catch { return }
      const messages = Array.isArray(body?.messages) ? body.messages : []
      if (messages.length === 0) return
      let changed = false

      if (hasSystemTransform) {
        changed = await applySystemTransform({ legacy, input, messages }) || changed
      }
      if (hasChatMessage) {
        changed = await applyChatMessage({ legacy, input, body, messages }) || changed
      }
      if (!changed) return
      body.messages = messages
      // `Request` is immutable. V2's HTTP hook consumes a replacement request;
      // this is the verified request-stage mutation boundary.
      input.request = new Request(input.request, { body: JSON.stringify(body) })
    }))
  }
}

async function applyChatMessage({ legacy, input, body, messages }) {
  const index = findLastUserMessage(messages)
  if (index < 0) return false
  const text = extractText(messages[index]?.content)
  if (!text) return false
  const output = { message: {}, parts: [{ type: "text", text }] }
  await legacy["chat.message"]({
    sessionID: input.sessionID,
    agent: input.agent,
    model: legacyModelRef(input.model),
  }, output)

  let changed = false
  const transformed = extractText(output.parts)
  if (transformed && transformed !== text) {
    const content = replaceTextContent(messages[index]?.content, transformed)
    if (content !== undefined) {
      messages[index] = { ...messages[index], content }
      changed = true
    }
  }
  const override = output.message?.model
  if (isSameProviderModelOverride(override, input.model) && typeof body.model === "string") {
    body.model = override.modelID
    changed = true
  } else if (hasUnsupportedChatMessageMutation(output.message, input.model)) {
    console.error("[oh-my-rigel] V2 chat.message ignored an agent, variant, or cross-provider model override: it occurs after V2 selected the provider route.")
  }
  return changed
}

async function applySystemTransform({ legacy, input, messages }) {
  const indices = messages.flatMap((message, index) => message?.role === "system" ? [index] : [])
  const original = indices.map((index) => extractText(messages[index]?.content)).filter(Boolean)
  const output = { system: [...original] }
  await legacy["experimental.chat.system.transform"](
    { sessionID: input.sessionID, model: legacyModelRef(input.model) },
    output,
  )
  const transformed = output.system.filter((text) => typeof text === "string" && text.length > 0)
  if (sameStrings(original, transformed)) return false
  const replacement = transformed.map((content) => ({ role: "system", content }))
  if (indices.length === 0) messages.unshift(...replacement)
  else {
    // System messages are normally contiguous but the provider payload does
    // not promise that. Remove exactly those messages without deleting an
    // intervening user/tool message, then preserve their original position.
    const insertionIndex = messages.slice(0, indices[0]).filter((message) => message?.role !== "system").length
    const withoutSystem = messages.filter((message) => message?.role !== "system")
    messages.splice(0, messages.length, ...withoutSystem)
    messages.splice(insertionIndex, 0, ...replacement)
  }
  return true
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

function findLastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

function legacyModelRef(model) {
  if (!model || typeof model !== "object") return undefined
  const providerID = model.providerID ?? model.provider
  const modelID = model.modelID ?? model.id
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
  return { providerID, modelID }
}

function isSameProviderModelOverride(override, currentModel) {
  if (!override || typeof override !== "object") return false
  const current = legacyModelRef(currentModel)
  return typeof override.providerID === "string"
    && typeof override.modelID === "string"
    && override.providerID === current?.providerID
}

function hasUnsupportedChatMessageMutation(message, currentModel) {
  if (!message || typeof message !== "object") return false
  if (typeof message.agent === "string" || typeof message.variant === "string" || typeof message.thinking === "string") return true
  const override = message.model
  return Boolean(override && typeof override === "object" && !isSameProviderModelOverride(override, currentModel))
}

function replaceTextContent(content, text) {
  if (typeof content === "string") return text
  if (!Array.isArray(content)) return undefined
  const index = content.findIndex((part) => part?.type === "text" && typeof part.text === "string")
  if (index < 0) return undefined
  return content.map((part, current) => current === index ? { ...part, text } : part)
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
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
