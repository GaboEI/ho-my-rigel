/**
 * Native V2 OpenClaw composition: the runtime-owned, bidirectional OpenClaw
 * surface. It binds the four pure halves together and exposes the three effects
 * the V2 runtime needs:
 *
 *   - `handleEvent(event)` is the OUTBOUND entry. The runtime calls it from its
 *     existing shared `ctx.event.subscribe` loop, so OpenClaw never opens a
 *     second subscription; an event whose hook has no gateway is a no-op.
 *   - `ready` is the INBOUND lifecycle. Construction starts the reply listener
 *     (owned by `setup`), and `dispose()` stops it, so no listener outlives the
 *     plugin. With no `replyListener` credentials the listener never starts and
 *     no request is made.
 *   - `status()` is the observability surface (enabled, listener started,
 *     registry size) for live QA.
 *
 * The single strict gate is the normalized config: `normalizeOpenclawConfig`
 * returns `null` unless `enabled === true`, so an absent or disabled block means
 * zero dispatch, zero listener and zero network. Every other effect keys off
 * that one gate.
 *
 * Only sibling native modules are imported so the flat laboratory runtime can
 * load this module.
 */
import { normalizeOpenclawConfig } from "./rigel-v2-native-openclaw-core.mjs"
import { createOpenclawOutbound } from "./rigel-v2-native-openclaw-outbound.mjs"
import { createOpenclawInbound, createInternalPromptGate } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"

/**
 * Compose the OpenClaw surface over a V2 setup context.
 *
 * @param {object} [options]
 * @param {object} [options.context] the V2 setup context (`storage`, `session`)
 * @param {object} [options.config] the materialized `openclaw` profile block
 * @param {typeof fetch} [options.fetchImpl] outbound HTTP + inbound poll transport
 * @param {Function} [options.spawnImpl] outbound command transport
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.platform]
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {(sessionID: string) => boolean} [options.isSubagentSession]
 */
export function createNativeOpenclaw({
  context,
  config,
  fetchImpl,
  spawnImpl,
  env = process.env,
  platform = process.platform,
  log = () => {},
  now,
  isSubagentSession,
} = {}) {
  const normalized = normalizeOpenclawConfig(config)
  const enabled = normalized !== null

  // The registry is the durable correlation store; `ctx.storage` is the V2
  // domain, and an absent one still works from the in-process index.
  const registry = createOpenclawRegistry({ storage: context?.storage, now, log })

  const outbound = createOpenclawOutbound({
    config: normalized,
    registry,
    fetchImpl,
    spawnImpl,
    env,
    platform,
    log,
    now,
    isSubagentSession,
  })

  // The inbound listener delivers ONLY through the internal prompt gate: the V2
  // equivalent of V1's `tmux send-keys` injection, but a real queued session
  // prompt the host has to accept.
  const deliverInboundReply = createInternalPromptGate({ session: context?.session })
  const inbound = createOpenclawInbound({
    replyListener: normalized?.replyListener,
    registry,
    deliverInboundReply,
    fetchImpl,
    log,
    now,
    ...(typeof env?.RIGEL_OPENCLAW_DISCORD_API_BASE === "string"
      ? { discordApiBase: env.RIGEL_OPENCLAW_DISCORD_API_BASE }
      : {}),
  })

  const ready = (async () => {
    if (!enabled) return { started: false, reason: "disabled" }
    try {
      await registry.hydrate()
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw registry hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const started = await inbound.start()
    return started.started ? { started: true } : { started: false, reason: started.reason ?? "no-credentials" }
  })()

  async function handleEvent(event) {
    if (!enabled) return null
    const result = await outbound.handleEvent(event)
    // A successful wake that returned correlation metadata just wrote a fresh
    // registry mapping; wake the listener so a reply quoting that message is
    // delivered on the next poll instead of after a full interval. `wake()` is a
    // no-op while the listener is not running, so an outbound-only config pays
    // nothing.
    if (result !== null && result.success === true && typeof result.messageId === "string" && typeof result.platform === "string" && event?.type !== "session.deleted") {
      inbound.wake()
    }
    return result
  }

  async function dispose() {
    await inbound.stop()
  }

  function status() {
    const value = { enabled, started: inbound.status().started }
    if (enabled) value.registry = registry.size()
    return value
  }

  return { enabled, ready, handleEvent, dispose, status, registry, inbound }
}
