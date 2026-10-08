/**
 * Pure update-check primitives for the Oh My Rigel native OpenCode V2 runtime.
 *
 * Ported from V1 `hooks/auto-update-checker` (`checker/semver-compare.ts`,
 * `version-channel.ts`, `checker/latest-version.ts`). Every function here is
 * deterministic: no fetch, no storage, no node builtins. The runtime layer
 * (`rigel-v2-native-update-checker.mjs`) injects the network and storage so the
 * decision logic is testable on the real surface.
 */

export const UPDATE_NOTICE_MARKER = "<rigel-native-update-notice>"

export const UPDATE_CHECK_TTL_MS = 86400000

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseSemver(version) {
  if (typeof version !== "string") return null
  const match = SEMVER_REGEX.exec(version.trim())
  if (!match) return null
  const [, major, minor, patch, prerelease] = match
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease ? prerelease.split(".") : [],
  }
}

function comparePrerelease(a, b) {
  // A release outranks any of its prereleases: 5.0.0-beta.89 < 5.0.0.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const idA = a[i] ?? ""
    const idB = b[i] ?? ""
    if (idA === idB) continue
    const numA = /^\d+$/.test(idA)
    const numB = /^\d+$/.test(idB)
    if (numA && numB) return Number(idA) < Number(idB) ? -1 : 1
    // Numeric identifiers sort before alphanumeric ones.
    if (numA) return -1
    if (numB) return 1
    return idA < idB ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * Returns -1 when `a` is older than `b`, 0 when equal, 1 when newer.
 * Returns null when either side is not parseable semver; callers must treat
 * null as "cannot tell" and never as "update available".
 */
export function compareSemverVersions(a, b) {
  const parsedA = parseSemver(a)
  const parsedB = parseSemver(b)
  if (!parsedA || !parsedB) return null

  for (let i = 0; i < 3; i++) {
    const partA = parsedA.core[i] ?? 0
    const partB = parsedB.core[i] ?? 0
    if (partA !== partB) return partA < partB ? -1 : 1
  }
  return comparePrerelease(parsedA.prerelease, parsedB.prerelease)
}

/** True only when `latestVersion` is strictly newer than `currentVersion`. */
export function isStrictlyNewerVersion(currentVersion, latestVersion) {
  return compareSemverVersions(currentVersion, latestVersion) === -1
}

/**
 * V1 `extractChannel`: null/undefined to `latest`, a dist-tag to itself, a
 * known prerelease prefix to that prefix, and anything else to `latest`.
 */
export function extractChannel(version) {
  if (version === null || version === undefined || version === "") return "latest"
  const value = String(version)

  if (!/^\d/.test(value)) {
    return value
  }

  if (value.includes("-")) {
    const prereleasePart = value.split("-")[1]
    if (prereleasePart) {
      const channelMatch = prereleasePart.match(/^(alpha|beta|rc|canary|next)/)
      if (channelMatch) return channelMatch[1]
    }
  }

  return "latest"
}

/**
 * Resolve the version for a channel, falling back to the `latest` tag the way
 * V1 `getLatestVersion` did (`data[channel] ?? data.latest ?? null`).
 */
export function resolveLatestForChannel(distTags, channel) {
  const channelValue = distTags?.[channel]
  if (typeof channelValue === "string") return channelValue
  const latest = distTags?.latest
  return typeof latest === "string" ? latest : undefined
}

/**
 * True unless `lastCheckedAt` is a usable past timestamp inside the TTL. A
 * future or non-numeric timestamp is stale, so a corrupt cache never wedges
 * the check.
 */
export function shouldRefresh(lastCheckedAt, now, ttlMs = UPDATE_CHECK_TTL_MS) {
  const isFresh = typeof lastCheckedAt === "number"
    && Number.isFinite(lastCheckedAt)
    && lastCheckedAt > 0
    && lastCheckedAt <= now
    && (now - lastCheckedAt) < ttlMs
  return !isFresh
}

/**
 * Human-readable notice injected into the root session's system channel. It
 * starts with the marker so the prompt layer can strip a previous injection
 * idempotently, and it states plainly that no update ever happens on its own.
 */
export function formatUpdateNotice({ currentVersion, latestVersion, packageName }) {
  const name = typeof packageName === "string" && packageName ? packageName : "the plugin"
  return `${UPDATE_NOTICE_MARKER}\nA newer version of ${name} is available: ${latestVersion} (current: ${currentVersion}). Updates are never automatic; rerun the installer or update ${name} yourself.\n</rigel-native-update-notice>`
}
