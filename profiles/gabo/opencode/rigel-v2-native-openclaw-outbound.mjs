/**
 * Native V2 OpenClaw outbound: map a raw session event to its configured hook,
 * dispatch it through the resolved gateway, and record the reply-correlation
 * mapping. Ported from `packages/openclaw-core/src/runtime-dispatch.ts` and the
 * `wakeOpenClaw` half of `src/index.ts`.
 *
 * Effects preserved from V1:
 *   - only `session.created`, `session.deleted` and `session.idle` react;
 *   - the first hook that resolves a gateway wins (a failure still stops the
 *     search, exactly like V1's "break on first non-null result");
 *   - a `session.created` for a subagent session is skipped;
 *   - a successful wake carrying `messageId` + `platform` writes a correlation
 *     mapping; `session.deleted` removes the session's mappings;
 *   - `OPENCLAW_REPLY_CHANNEL` / `OPENCLAW_REPLY_TARGET` / `OPENCLAW_REPLY_THREAD`
 *     are the environment fallbacks for reply correlation;
 *   - observability only under `OMO_OPENCLAW_DEBUG=1`.
 */
import {
  buildOpenclawPayload,
  buildWhitelistedContext,
  interpolateInstruction,
  mapRawEventToHooks,
  normalizePlatform,
  projectNameOf,
  resolveGateway,
} from "./rigel-v2-native-openclaw-core.mjs"
import { dispatchGateway } from "./rigel-v2-native-openclaw-transport.mjs"

export function createOpenclawOutbound({
  config,
  registry,
  fetchImpl,
  spawnImpl,
  env = process.env,
  platform = process.platform,
  commandTimeoutEnv,
  log = () => {},
  now = () => Date.now(),
  isSubagentSession,
} = {}) {
  const enabled = Boolean(config && config.enabled === true)
  const debug = env?.OMO_OPENCLAW_DEBUG === "1"

  async function handleEvent(event) {
    if (!enabled) return null
    const rawEvent = event?.type
    const hooks = mapRawEventToHooks(rawEvent)
    if (hooks.length === 0) return null
    const sessionID = event?.sessionID
    if (typeof sessionID !== "string" || sessionID.length === 0) return null

    if (rawEvent === "session.created" && typeof isSubagentSession === "function" && isSubagentSession(sessionID)) {
      return null
    }

    const timestamp = new Date(now()).toISOString()
    const projectPath = typeof event.projectPath === "string" ? event.projectPath : ""
    const replyChannel = event.replyChannel ?? env?.OPENCLAW_REPLY_CHANNEL
    const replyTarget = event.replyTarget ?? env?.OPENCLAW_REPLY_TARGET
    const replyThread = event.replyThread ?? env?.OPENCLAW_REPLY_THREAD
    const tmuxSession = typeof event.tmuxSession === "string" ? event.tmuxSession : undefined

    let result = null
    for (const hook of hooks) {
      const resolved = resolveGateway(config, hook)
      if (!resolved) continue
      const context = {
        sessionId: sessionID,
        projectPath,
        projectName: projectNameOf(projectPath),
        tmuxSession,
        prompt: event.prompt,
        contextSummary: event.contextSummary,
        reasoning: event.reasoning,
        question: event.question,
        tmuxTail: event.tmuxTail,
        replyChannel,
        replyTarget,
        replyThread,
      }
      const variables = {}
      for (const [key, value] of Object.entries(context)) if (value !== undefined) variables[key] = String(value)
      variables.event = hook
      variables.timestamp = timestamp
      const interpolatedInstruction = interpolateInstruction(resolved.instruction, variables)
      variables.instruction = interpolatedInstruction
      if (resolved.gateway.type === "command") {
        variables.context = buildWhitelistedContext(context)
        result = await dispatchGateway({
          gatewayName: resolved.gatewayName,
          gateway: resolved.gateway,
          variables,
          spawnImpl,
          env,
          platform,
          commandTimeoutEnv,
        })
      } else {
        const payload = buildOpenclawPayload({ event: hook, instruction: interpolatedInstruction, timestamp, context })
        result = await dispatchGateway({
          gatewayName: resolved.gatewayName,
          gateway: resolved.gateway,
          payload,
          fetchImpl,
        })
      }
      break
    }

    if (result !== null && result.success === true && typeof result.messageId === "string" && typeof result.platform === "string" && rawEvent !== "session.deleted") {
      await registry?.register?.({
        sessionID,
        projectPath,
        platform: normalizePlatform(result.platform),
        messageId: result.messageId,
        channelId: result.channelId,
        threadId: result.threadId,
        createdAt: timestamp,
      })
    }
    if (rawEvent === "session.deleted") {
      await registry?.removeSession?.(sessionID)
    }
    if (debug && result !== null) {
      log(`[openclaw] wake ${rawEvent} -> ${result.gateway}: ${result.success ? "ok" : result.error ?? "failed"}`)
    }
    return result
  }

  return { enabled, handleEvent }
}
