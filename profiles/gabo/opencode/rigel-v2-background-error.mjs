// allow: SIZE_OK - one indivisible port of the V1 error taxonomy; the branch
// order and pattern tables are a single contract pinned by the parity test, so
// splitting them would scatter the order the test protects.
/**
 * Pure provider-error taxonomy for Oh My Rigel's native OpenCode V2 background
 * retry policy.
 *
 * Plain-JS port of the matching OmO revision, consumed by
 * `rigel-v2-background-retry.mjs`:
 *   packages/model-core/src/model-error-classifier.ts
 *     isRetryableModelError (110-145), shouldRetryError (151-153)
 *   packages/model-core/src/provider-exhaustion-fallback-policy.ts
 *     isProviderExhaustionFallbackEligible (12-14)
 *   packages/model-core/src/runtime-fallback-error-classifier.ts
 *     isTerminalQuotaError (89-91), classifyRuntimeFallbackError (93-168)
 *   packages/model-core/src/runtime-fallback-error-shape.ts
 *     getRuntimeFallbackErrorMessage (24-65), getRuntimeFallbackErrorName (100-116)
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so the
 * taxonomy lives here as pure functions. `rigel-v2-background-retry.test.mjs`
 * imports the real TS owners and pins parity across an error corpus, so upstream
 * drift in a name set, message pattern, status-code gate, or branch order fails
 * the suite.
 *
 * Pure module: no imports, no runtime dependencies, no I/O, no timers.
 */

/**
 * Error names that indicate a retryable model error.
 * These errors halt execution and should trigger fallback retry.
 */
const RETRYABLE_ERROR_NAMES = new Set([
  "providermodelnotfounderror",
  "ratelimiterror",
  "modelunavailableerror",
  "providerconnectionerror",
  "authenticationerror",
])

/**
 * Error names that should NOT trigger retry.
 * These errors are typically user-induced or fixable without switching models.
 */
const NON_RETRYABLE_ERROR_NAMES = new Set([
  "messageabortederror",
  "permissiondeniederror",
  "contextlengtherror",
  "timeouterror",
  "validationerror",
  "syntaxerror",
  "usererror",
])

/**
 * Message patterns that indicate a retryable error even without a known error
 * name. Matched against the lowercased message with `includes`.
 */
const RETRYABLE_MESSAGE_PATTERNS = [
  "rate_limit",
  "rate limit",
  "usage_limit_reached",
  "usage limit has been reached",
  "quota",
  "all credentials for model",
  "cooling down",
  "exhausted your capacity",
  "not found",
  "unavailable",
  "insufficient",
  "too many requests",
  "over limit",
  "overloaded",
  "bad gateway",
  "bad request",
  "unknown provider",
  "provider not found",
  "model_not_supported",
  "model not supported",
  "model is not supported",
  "connection error",
  "network error",
  "timeout",
  "service unavailable",
  "internal_server_error",
  "free usage",
  "usage exceeded",
  "credit",
  "balance",
  "temporarily unavailable",
  "try again",
  "请稍后重试",
  "503",
  "502",
  "504",
  "429",
  "529",
  "selected provider is forbidden",
  "provider is forbidden",
  // Chinese retryable patterns (Zhipu, etc.)
  "频率限制",
  "请求过于频繁",
  "暂时不可用",
  "服务不可用",
  "server_error",
  "an error occurred while processing",
  "upstream request failed",
]

const AUTO_RETRY_GATE_PATTERNS = [
  "rate limit",
  "cooling down",
  "credentials for model",
]

function hasProviderAutoRetrySignal(message) {
  if (!message.includes("retrying in")) {
    return false
  }
  return AUTO_RETRY_GATE_PATTERNS.some((pattern) => message.includes(pattern))
}

function isUnknownRecord(value) {
  return typeof value === "object" && value !== null
}

function getUnknownProperty(value, key) {
  return isUnknownRecord(value) ? value[key] : undefined
}

function getNestedRecord(record, key) {
  const value = getUnknownProperty(record, key)
  return isUnknownRecord(value) ? value : undefined
}

/**
 * Extract the lowercased message an error carries, mirroring V1
 * `getRuntimeFallbackErrorMessage`. A plain `{ name, message }` errorInfo yields
 * the lowercased `message`; nested `data`/`error` shapes are also read.
 */
export function getRuntimeFallbackErrorMessage(error) {
  if (!error) return ""
  if (typeof error === "string") return error.toLowerCase()

  if (!isUnknownRecord(error)) {
    try {
      return JSON.stringify(error).toLowerCase()
    } catch {
      return ""
    }
  }

  const data = getNestedRecord(error, "data")
  const nestedError = getNestedRecord(error, "error")
  const dataError = getNestedRecord(data, "error")
  const records = [data, nestedError, error, dataError].filter((value) => value !== undefined)

  for (const record of records) {
    const message = getUnknownProperty(record, "message")
    if (typeof message === "string" && message.length > 0) {
      return message.toLowerCase()
    }
  }

  const name = getUnknownProperty(error, "name")
  if (typeof name === "string" && name.length > 0) {
    const nameColonMatch = name.match(/:\s*(.+)/)
    if (nameColonMatch) return nameColonMatch[1]?.trim().toLowerCase() ?? ""
  }

  try {
    return JSON.stringify(error).toLowerCase()
  } catch {
    return ""
  }
}

/**
 * Extract the error name, mirroring V1 `getRuntimeFallbackErrorName`: the first
 * `name` found on the error, its `data`, its nested `error`, or `data.error`.
 */
export function getRuntimeFallbackErrorName(error) {
  if (!isUnknownRecord(error)) return undefined

  const data = getNestedRecord(error, "data")
  const nestedError = getNestedRecord(error, "error")
  const dataError = getNestedRecord(data, "error")
  const records = [error, data, nestedError, dataError].filter((value) => value !== undefined)

  for (const record of records) {
    const name = getUnknownProperty(record, "name")
    if (typeof name === "string" && name.length > 0) {
      return name
    }
  }

  return undefined
}

function getDetailErrorType(error) {
  const data = getUnknownProperty(error, "data")
  const detail = getUnknownProperty(error, "detail") ?? getUnknownProperty(data, "detail") ?? error
  const detailError = getUnknownProperty(detail, "error") ?? detail
  const type = getUnknownProperty(detailError, "type") ?? getUnknownProperty(detail, "type")
  return typeof type === "string" ? type.toLowerCase() : undefined
}

function isLocalizedQuotaExhaustionMessage(message) {
  return (
    (/预扣费额度失败/i.test(message) && /用户剩余额度/i.test(message)) ||
    (/用户剩余额度/i.test(message) && /需要预扣费额度/i.test(message))
  )
}

function isTerminalQuotaMessage(message) {
  if (
    /\bnon[-\s]+terminal\s+quota\b/i.test(message) ||
    /\bnon[-\s]+terminal\s+billing\s+limit\b/i.test(message)
  ) {
    return false
  }
  return (
    /\bterminal\s+quota\b/i.test(message) ||
    /\bterminal\s+billing\s+limit\b/i.test(message) ||
    /\bhard\s+billing\s+limit\b/i.test(message)
  )
}

/** A quota the provider marks as permanent: no reset, so no fallback retry either. */
export function isTerminalQuotaError(error) {
  return getDetailErrorType(error) === "terminal_quota_exhausted" || isTerminalQuotaMessage(getRuntimeFallbackErrorMessage(error))
}

/**
 * Classify a runtime fallback error, mirroring V1 `classifyRuntimeFallbackError`.
 * The branch order matters: an earlier (non-quota) classification wins over the
 * quota branch.
 */
export function classifyRuntimeFallbackError(error) {
  if (isTerminalQuotaError(error)) {
    return "abort"
  }

  const message = getRuntimeFallbackErrorMessage(error)
  const errorName = getRuntimeFallbackErrorName(error)?.toLowerCase().replace(/[_-]/g, "")

  if (errorName?.includes("messageabortederror") || errorName?.includes("aborterror")) {
    return "abort"
  }

  if (errorName === "contextoverflowerror") {
    return "context_overflow"
  }

  if (
    errorName?.includes("ailoadapikeyerror") ||
    errorName?.includes("loadapi") ||
    (/api.?key.?is.?missing/i.test(message) && /environment variable/i.test(message))
  ) {
    return "missing_api_key"
  }

  if (/api.?key/i.test(message) && /must be a string/i.test(message)) {
    return "invalid_api_key"
  }

  if (
    errorName?.includes("providermodelnotfounderror") ||
    errorName?.includes("modelnotfounderror") ||
    (errorName?.includes("unknownerror") && /model\s+not\s+found/i.test(message))
  ) {
    return "model_not_found"
  }

  if (
    errorName?.includes("quotaexceeded") ||
    errorName?.includes("insufficientquota") ||
    errorName?.includes("billingerror") ||
    errorName?.includes("resourceexhausted") ||
    errorName?.includes("insufficientcredits") ||
    errorName?.includes("usagelimit") ||
    /quota.?exceeded/i.test(message) ||
    /exceeded.*quota/i.test(message) ||
    /quota\b.*\breset/i.test(message) ||
    /usage\s*quota/i.test(message) ||
    /subscription.?(?:quota|limit)/i.test(message) ||
    /insufficient.?(?:quota|balance|funds?|credits?)/i.test(message) ||
    /credits?\s+exhausted/i.test(message) ||
    /\b(?:session|weekly|monthly|daily|hourly|\d+[-\s]hour|plan|call)\s+limit\b/i.test(message) ||
    /\bhit\s+your\b[^.]*\blimit\b/i.test(message) ||
    /\bin\s+arrears\b/i.test(message) ||
    /\brecharge\s+and\s+try\b/i.test(message) ||
    /billing.?(?:hard.?)?limit/i.test(message) ||
    /exhausted\s+your\s+capacity/i.test(message) ||
    /resource.?exhausted/i.test(message) ||
    /out\s+of\s+credits?/i.test(message) ||
    /payment.?required/i.test(message) ||
    /usage\s+limit/i.test(message) ||
    /credit\s+balance.*too\s+low/i.test(message) ||
    /limit\s+exhausted/i.test(message) ||
    /使用上限/.test(message) ||
    /用量上限/.test(message) ||
    /达到.*限制/.test(message) ||
    /额度.*不足/.test(message) ||
    /余额.*不足/.test(message) ||
    /已耗尽/.test(message) ||
    isLocalizedQuotaExhaustionMessage(message)
  ) {
    return "quota_exceeded"
  }

  return undefined
}

/**
 * Determines if an error is a retryable model error, mirroring V1
 * `isRetryableModelError`: a known retryable name, a provider auto-retry signal,
 * an HTTP 429/503/529, or a retryable message pattern. A non-retryable name or a
 * terminal quota never retries.
 */
export function isRetryableModelError(error) {
  const errorNameLower = typeof error?.name === "string" ? error.name.toLowerCase() : undefined
  if (errorNameLower !== undefined && NON_RETRYABLE_ERROR_NAMES.has(errorNameLower)) {
    return false
  }

  if (isTerminalQuotaError(error)) {
    return false
  }
  if (classifyRuntimeFallbackError(error) === "quota_exceeded") {
    return true
  }

  if (errorNameLower !== undefined && RETRYABLE_ERROR_NAMES.has(errorNameLower)) {
    return true
  }

  const msg = typeof error?.message === "string" ? error.message.toLowerCase() : ""

  if (hasProviderAutoRetrySignal(msg)) {
    return true
  }

  if (
    error?.statusCode !== undefined &&
    error.statusCode !== null &&
    (error.statusCode === 429 || error.statusCode === 503 || error.statusCode === 529)
  ) {
    return true
  }

  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => msg.includes(pattern))
}

/**
 * Determines if an error should trigger a fallback retry, mirroring V1
 * `shouldRetryError`.
 */
export function shouldRetryError(error) {
  return isRetryableModelError(error)
}

/**
 * Whether an error is a provider-exhaustion (quota) signal eligible for the
 * fallback chain, mirroring V1 `isProviderExhaustionFallbackEligible`.
 */
export function isProviderExhaustionFallbackEligible(error) {
  return classifyRuntimeFallbackError(error) === "quota_exceeded"
}
