/**
 * Durable update-check state over the native V2 `ctx.storage` domain.
 *
 * Mirrors the tolerant-read style of `tools/session-todo-store.mjs`: a missing
 * or malformed record reads as an empty object, and a storage write never
 * propagates its failure into the non-blocking check. The state object is
 * injected into `rigel-v2-native-update-checker.mjs`; the checker never
 * imports this module, so it can be exercised with any storage double.
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function createNativeUpdateState({
  storage,
  prefix = "rigel-v2/update-check",
  key = "status",
  onError,
} = {}) {
  const available = Boolean(storage)
    && typeof storage.get === "function"
    && typeof storage.set === "function"
  const storageKey = `${prefix}/${key}`

  function report(error) {
    if (typeof onError !== "function") return
    try {
      onError(error)
    } catch (nested) {
      // A throwing reporter must not break the read/write path.
      void nested
    }
  }

  return {
    available,
    async read() {
      if (!available) return {}
      let value
      try {
        value = await storage.get(storageKey)
      } catch {
        return {}
      }
      if (!isPlainObject(value)) return {}
      return value
    },
    async write(record) {
      if (!available) return
      try {
        await storage.set(storageKey, record)
      } catch (error) {
        report(error)
      }
    },
  }
}
