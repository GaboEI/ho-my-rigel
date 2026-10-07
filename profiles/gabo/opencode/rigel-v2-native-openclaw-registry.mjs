/**
 * Native V2 OpenClaw correlation registry.
 *
 * V1 stored a file-locked JSONL mapping (`session-registry.ts`) that answered one
 * question: which OpenCode session did we send the outbound message a reply is
 * quoting? The V2 runtime answers the same question with native plugin storage
 * (`ctx.storage`), so the mapping survives a plugin reload without inventing a
 * second global file. The effect is preserved:
 *
 *   - written only on a successful outbound wake that returned a `messageId` and
 *     a `platform` (never for `session.deleted`);
 *   - looked up by `(platform, replyToMessageId)`;
 *   - removed for a deleted session;
 *   - pruned after 24 hours, like `MAX_AGE_MS`.
 *
 * A process-local Map is the working index; storage is the durable mirror. When
 * the host exposes no storage domain (a unit fixture or a degraded host) the map
 * still works, so the surface degrades instead of throwing.
 */
import { createHash } from "node:crypto"
import { normalizePlatform } from "./rigel-v2-native-openclaw-core.mjs"

export const OPENCLAW_REGISTRY_PREFIX = "rigel-v2/openclaw/registry/"
export const OPENCLAW_REGISTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isValidMapping(value) {
  return isPlainObject(value)
    && typeof value.sessionID === "string" && value.sessionID.length > 0
    && typeof value.platform === "string" && value.platform.length > 0
    && typeof value.messageId === "string" && value.messageId.length > 0
    && typeof value.createdAt === "string" && value.createdAt.length > 0
}

function keyFor(platform, messageId) {
  const hash = createHash("sha1").update(`${platform}\u0000${messageId}`).digest("hex")
  return `${OPENCLAW_REGISTRY_PREFIX}${hash}`
}

/**
 * Create the registry. `storage` is the V2 plugin storage domain; it may be
 * absent. `hydrate()` should be awaited once before the inbound poller starts so
 * mappings written by a previous process are visible.
 */
export function createOpenclawRegistry({ storage, maxAgeMs = OPENCLAW_REGISTRY_MAX_AGE_MS, now = () => Date.now(), log = () => {} } = {}) {
  const map = new Map()
  const canPersist = Boolean(storage && typeof storage.set === "function" && typeof storage.get === "function")
  const canScan = Boolean(storage && typeof storage.scan === "function")
  const canRemove = Boolean(storage && typeof storage.remove === "function")

  function indexKey(platform, messageId) {
    return `${platform}\u0000${messageId}`
  }

  function isFresh(mapping) {
    const created = Date.parse(mapping.createdAt)
    return Number.isFinite(created) && now() - created <= maxAgeMs
  }

  function remember(mapping) {
    map.set(indexKey(mapping.platform, mapping.messageId), mapping)
  }

  async function hydrate() {
    if (!canScan) return
    try {
      const page = await storage.scan({ prefix: OPENCLAW_REGISTRY_PREFIX })
      const entries = Array.isArray(page?.entries) ? page.entries : []
      for (const entry of entries) {
        const value = entry?.value
        if (!isValidMapping(value) || !isFresh(value)) continue
        remember(value)
      }
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw registry hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function register(mapping) {
    if (!isValidMapping(mapping)) return false
    const normalized = { ...mapping, platform: normalizePlatform(mapping.platform) }
    remember(normalized)
    if (canPersist) {
      try {
        await storage.set(keyFor(normalized.platform, normalized.messageId), normalized)
      } catch (error) {
        log(`[oh-my-rigel] Native V2 openclaw registry persist failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return true
  }

  function lookup(platform, messageId) {
    if (typeof platform !== "string" || typeof messageId !== "string") return null
    const key = indexKey(platform, messageId)
    const mapping = map.get(key)
    if (!mapping) return null
    if (!isFresh(mapping)) {
      map.delete(key)
      if (canRemove) void storage.remove(keyFor(mapping.platform, mapping.messageId)).catch(() => {})
      return null
    }
    return mapping
  }

  async function prune() {
    let removed = 0
    for (const [key, mapping] of [...map.entries()]) {
      if (isFresh(mapping)) continue
      map.delete(key)
      removed += 1
      if (canRemove) {
        try {
          await storage.remove(keyFor(mapping.platform, mapping.messageId))
        } catch {
          // best effort; the in-memory entry is already gone
        }
      }
    }
    return removed
  }

  async function removeSession(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return 0
    let removed = 0
    for (const [key, mapping] of [...map.entries()]) {
      if (mapping.sessionID !== sessionID) continue
      map.delete(key)
      removed += 1
      if (canRemove) {
        try {
          await storage.remove(keyFor(mapping.platform, mapping.messageId))
        } catch {
          // best effort
        }
      }
    }
    return removed
  }

  return {
    hydrate,
    register,
    lookup,
    prune,
    removeSession,
    list: () => [...map.values()],
    size: () => map.size,
  }
}
