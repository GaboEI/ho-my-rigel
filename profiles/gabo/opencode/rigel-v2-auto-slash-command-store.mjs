const MAX_PROCESSED_ENTRY_COUNT = 10_000
const PROCESSED_COMMAND_TTL_MS = 30_000

export function createProcessedCommandStore({ now = () => Date.now() } = {}) {
  const entries = new Map()

  function prune() {
    const current = now()
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= current) entries.delete(key)
    }
  }

  return {
    has(key) {
      prune()
      return entries.has(key)
    },
    add(key, ttlMs = PROCESSED_COMMAND_TTL_MS) {
      prune()
      entries.delete(key)
      entries.set(key, now() + ttlMs)
      while (entries.size > MAX_PROCESSED_ENTRY_COUNT) entries.delete(entries.keys().next().value)
    },
    clear() {
      entries.clear()
    },
  }
}
