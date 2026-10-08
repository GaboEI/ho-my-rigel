/**
 * Non-blocking update checker for the Oh My Rigel native OpenCode V2 runtime.
 *
 * Ports the V1 `hooks/auto-update-checker` effect: at most one registry check
 * per process, a durable per-day cache in the injected state, and a system
 * notice when a strictly newer version is published. It never installs
 * anything and never throws: every failure degrades to a log plus a receipt.
 */

import {
  UPDATE_CHECK_TTL_MS,
  extractChannel,
  formatUpdateNotice,
  isStrictlyNewerVersion,
  resolveLatestForChannel,
  shouldRefresh,
} from "./rigel-v2-native-update-core.mjs"

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createNativeUpdateChecker({
  state,
  fetchImpl,
  registryUrl,
  packageName,
  currentVersion,
  ttlMs = UPDATE_CHECK_TTL_MS,
  now = () => Date.now(),
  timeoutMs = 5000,
  logger = () => {},
  onReceipt = () => {},
} = {}) {
  let knownLatest
  let attempted = false
  const stateAvailable = Boolean(state) && state.available === true

  function log(message) {
    try {
      logger(message)
    } catch (error) {
      console.error(`[oh-my-rigel] update check logger failed: ${describeError(error)}`)
    }
  }

  function emit(receipt) {
    try {
      onReceipt(receipt)
    } catch (error) {
      log(`update receipt failed: ${describeError(error)}`)
    }
  }

  async function persist(record) {
    if (!stateAvailable) return
    await state.write(record)
  }

  return {
    async refresh() {
      if (attempted) return
      attempted = true

      if (!currentVersion || !registryUrl || typeof fetchImpl !== "function") {
        log("update check skipped: no version/registry/fetch")
        emit({ outcome: "skipped" })
        return
      }

      let record = {}
      if (stateAvailable) {
        record = await state.read()
        if (typeof record.latest === "string") knownLatest = record.latest
        if (!shouldRefresh(record.lastCheckedAt, now(), ttlMs)) {
          log("update check skipped (cached)")
          emit({ outcome: "cached" })
          return
        }
      }

      // Record the attempt before fetching so a failing network call still
      // counts as the day's single attempt instead of retrying in a loop.
      await persist({ ...record, lastCheckedAt: now() })

      try {
        const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined
        const response = await fetchImpl(registryUrl, {
          headers: { accept: "application/json" },
          signal,
        })
        if (!response || response.ok === false) {
          throw new Error(`registry status ${response?.status}`)
        }
        const data = await response.json()
        const latest = resolveLatestForChannel(data, extractChannel(currentVersion))
        if (typeof latest !== "string" || !latest) {
          throw new Error("registry response carried no version")
        }
        knownLatest = latest
        await persist({ ...record, lastCheckedAt: now(), latest })
        if (isStrictlyNewerVersion(currentVersion, latest)) {
          emit({ outcome: "updateAvailable", currentVersion, latestVersion: latest })
          return
        }
        emit({ outcome: "upToDate", currentVersion, latestVersion: latest })
      } catch (error) {
        log(`update check failed: ${describeError(error)}`)
        emit({ outcome: "failed", error: describeError(error) })
      }
    },
    getNotice() {
      // Derive the notice from the last known registry version, whether it was
      // fetched this process or read from the daily cache, so a newer version
      // keeps announcing itself after a restart instead of only once. The
      // formatted notice carries the marker the prompt layer strips by, so the
      // injection stays a single idempotent block.
      if (!currentVersion || typeof knownLatest !== "string") return ""
      return isStrictlyNewerVersion(currentVersion, knownLatest)
        ? formatUpdateNotice({ currentVersion, latestVersion: knownLatest, packageName })
        : ""
    },
  }
}
