// Native OpenCode V2 port of V1's webfetch redirect guard, from
// `packages/omo-opencode/src/hooks/webfetch-redirect-guard/` (constants,
// redirect-resolution, hook). `before(event)` pre-resolves and rewrites the
// args URL; `after(event)` normalizes the mutable result text; `clear`/
// `clearAll` drop tracked state. The V2 catalog names the tool `webfetch`
// (see installer permissions), so this guard matches `webfetch` only.

export const DEFAULT_WEBFETCH_TIMEOUT_MS = 30_000
export const MAX_WEBFETCH_TIMEOUT_MS = 120_000
export const MAX_WEBFETCH_REDIRECTS = 10
export const WEBFETCH_REDIRECT_GUARD_STALE_TIMEOUT_MS = 15 * 60 * 1000
export const WEBFETCH_REDIRECT_ERROR_PATTERNS = [
  /redirected too many times/i,
  /too many redirects/i,
]
export const WEBFETCH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const WEBFETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

function buildAcceptHeader(format) {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

function buildWebFetchHeaders(format) {
  return {
    "User-Agent": WEBFETCH_USER_AGENT,
    Accept: buildAcceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
  }
}

function normalizeTimeoutMs(timeoutSeconds) {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return DEFAULT_WEBFETCH_TIMEOUT_MS
  }
  return Math.min(timeoutSeconds * 1000, MAX_WEBFETCH_TIMEOUT_MS)
}

function resolveRedirectLocation(currentUrl, location) {
  return new URL(location, currentUrl).toString()
}

export async function resolveWebFetchRedirects({
  url,
  format = "markdown",
  timeoutSeconds,
  fetch: fetchImpl = globalThis.fetch,
}) {
  const timeoutMs = normalizeTimeoutMs(timeoutSeconds)
  const signal = AbortSignal.timeout(timeoutMs)
  const headers = buildWebFetchHeaders(format)

  let currentUrl = url
  let redirectCount = 0

  while (true) {
    const response = await fetchImpl(currentUrl, { headers, redirect: "manual", signal })

    if (!WEBFETCH_REDIRECT_STATUSES.has(response.status)) {
      return { type: "resolved", url: currentUrl }
    }

    const location = response.headers.get("location")
    if (!location) {
      return { type: "resolved", url: currentUrl }
    }

    if (redirectCount >= MAX_WEBFETCH_REDIRECTS) {
      return { type: "exceeded", url, maxRedirects: MAX_WEBFETCH_REDIRECTS }
    }

    currentUrl = resolveRedirectLocation(currentUrl, location)
    redirectCount += 1
  }
}

function isWebFetchTool(toolName) {
  return String(toolName ?? "").toLowerCase() === "webfetch"
}

function getWebFetchUrl(args) {
  return args && typeof args.url === "string" && args.url.length > 0 ? args.url : undefined
}

function getWebFetchFormat(args) {
  return args && (args.format === "text" || args.format === "html") ? args.format : "markdown"
}

function getTimeoutSeconds(args) {
  return args && typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : undefined
}

function pendingKey(event) {
  const args = event?.input ?? event?.args ?? {}
  const url = getWebFetchUrl(args)
  if (typeof event?.id === "string" && event.id) return event.id
  if (typeof event?.sessionID === "string" && event.sessionID && url) return `${event.sessionID}|${url}`
  return url
}

function cleanupStaleEntries(pendingFailures, staleTimeoutMs) {
  const now = Date.now()
  for (const [key, value] of pendingFailures) {
    if (now - value.storedAt > staleTimeoutMs) pendingFailures.delete(key)
  }
}

function isRedirectLoopError(text) {
  return WEBFETCH_REDIRECT_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

function isToolErrorOutput(text) {
  return text.trimStart().toLowerCase().startsWith("error:")
}

function buildRedirectLimitMessage(url) {
  const suffix = url ? ` for ${url}` : ""
  return `Error: WebFetch failed: exceeded maximum redirects (${MAX_WEBFETCH_REDIRECTS})${suffix}`
}

function writeIfMutable(target, key, value) {
  if (!target || typeof target !== "object" || Object.isFrozen(target)) return false
  try {
    target[key] = value
    return true
  } catch {
    return false
  }
}

// Finds the mutable result text: an `output` string, an `output.content` /
// `content` array of `{ type: "text", text }` parts, or a `result` string.
// `write` is a no-op on a frozen container so callers stay safe.
function findResultText(event) {
  if (typeof event?.output === "string") {
    return {
      read: () => event.output,
      write: (value) => writeIfMutable(event, "output", value),
    }
  }

  const containers = [event?.output, event]
  for (const container of containers) {
    if (!container || !Array.isArray(container.content)) continue
    const part = container.content.find((entry) => entry && typeof entry === "object" && typeof entry.text === "string")
    if (part) {
      return {
        read: () => part.text,
        write: (value) => writeIfMutable(part, "text", value),
      }
    }
  }

  if (typeof event?.result === "string") {
    return {
      read: () => event.result,
      write: (value) => writeIfMutable(event, "result", value),
    }
  }

  return undefined
}

/** Native V2 equivalent of V1's webfetch redirect guard. */
export function createNativeWebFetchRedirectGuard(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const staleTimeoutMs = Number.isFinite(deps.staleTimeoutMs)
    ? deps.staleTimeoutMs
    : WEBFETCH_REDIRECT_GUARD_STALE_TIMEOUT_MS
  const pendingFailures = new Map()

  return {
    async before(event) {
      if (!isWebFetchTool(event?.tool)) return
      const args = event?.input ?? event?.args
      if (!args || typeof args !== "object") return
      const url = getWebFetchUrl(args)
      if (!url) return

      cleanupStaleEntries(pendingFailures, staleTimeoutMs)
      const key = pendingKey(event)

      try {
        const resolution = await resolveWebFetchRedirects({
          url,
          format: getWebFetchFormat(args),
          timeoutSeconds: getTimeoutSeconds(args),
          fetch: fetchImpl,
        })

        if (resolution.type === "resolved") {
          args.url = resolution.url
          return
        }

        if (key) pendingFailures.set(key, { originalUrl: url, storedAt: Date.now() })
      } catch {
        if (key) pendingFailures.set(key, { originalUrl: url, storedAt: Date.now() })
      }
    },

    async after(event) {
      if (!isWebFetchTool(event?.tool)) return
      const text = findResultText(event)
      if (!text) return

      const key = pendingKey(event)
      const pendingFailure = key ? pendingFailures.get(key) : undefined
      if (pendingFailure) {
        pendingFailures.delete(key)
        text.write(buildRedirectLimitMessage(pendingFailure.originalUrl))
        return
      }

      const current = text.read()
      if (typeof current === "string" && isToolErrorOutput(current) && isRedirectLoopError(current)) {
        text.write(buildRedirectLimitMessage())
      }
    },

    clear(sessionID) {
      if (typeof sessionID !== "string") return
      for (const key of pendingFailures.keys()) {
        if (key === sessionID || key.startsWith(`${sessionID}|`)) pendingFailures.delete(key)
      }
    },

    clearAll() {
      pendingFailures.clear()
    },
  }
}
