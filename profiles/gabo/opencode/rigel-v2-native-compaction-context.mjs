/**
 * Rigel native V2 compaction-context injection.
 *
 * Pure port of the V1 surfaces that keep a session oriented after context-window
 * compaction:
 *
 * - `COMPACTION_CONTEXT_MARKER` / `COMPACTION_CONTEXT_PROMPT` from
 *   `packages/omo-opencode/src/shared/system-directive.ts` and
 *   `packages/omo-opencode/src/hooks/compaction-context-injector/compaction-context-prompt.ts`.
 * - `formatDelegatedSessionHistory` from the V1 `TaskHistory.formatForCompaction`
 *   in `packages/omo-opencode/src/features/background-agent/task-history.ts`.
 * - `classifyProviderRequest` from the response-kind heuristics in
 *   `profiles/gabo/fixtures/fake-openai-native-delegation.mjs`.
 *
 * Two injection builders ship so the runtime can wire whichever the live
 * experiment proves: the A1 messages hook (`createNativeCompactionContextHook`)
 * appends the block to a live messages array; the A2 request step
 * (`createCompactionContextStep`) injects into a provider request body.
 *
 * Pure module: no I/O, no runtime dependencies, no imports from the native
 * runtime entrypoint.
 */

// ---------------------------------------------------------------------------
// V1 system directive constants
// ---------------------------------------------------------------------------

const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE"
const COMPACTION_CONTEXT_TYPE = "COMPACTION CONTEXT"

/**
 * The V1 `createSystemDirective(SystemDirectiveTypes.COMPACTION_CONTEXT)` value,
 * derived from the same constants the V1 owner composes:
 * `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT]`.
 */
export const COMPACTION_CONTEXT_MARKER = `${SYSTEM_DIRECTIVE_PREFIX} - ${COMPACTION_CONTEXT_TYPE}]`

/**
 * Byte-for-byte port of the V1 `COMPACTION_CONTEXT_PROMPT` template. The body
 * (the 8 sections plus the trailing continuity line) is identical to the V1
 * source; only the header interpolation is expressed through this module's
 * marker constant. The co-located test proves byte-identity against the V1
 * `.ts` parsed at test time.
 */
export const COMPACTION_CONTEXT_PROMPT = `${COMPACTION_CONTEXT_MARKER}

When summarizing this session, keep the result compact and continuation-focused. Prefer terse bullets over replaying the transcript.

## 1. User Requests
- Summarize the latest unresolved user requests and any earlier request still affecting the work
- Quote exact wording only when a later agent needs the literal phrase

## 2. Final Goal
- What the user ultimately wanted to achieve
- The end result or deliverable expected

## 3. Work Completed
- What has been done so far
- Files created/modified
- Validation already run and its result

## 4. Remaining Tasks
- What still needs to be done
- Pending items from the original request
- Known blockers or risks

## 5. Active Working Context (For Seamless Continuation)
- **Files**: Paths of files currently being edited or frequently referenced
- **Code in Progress**: Function names, data structures, or decisions under active development
- **External References**: Only URLs or docs that are still needed
- **State & Variables**: Important variable names, configuration values, or runtime state relevant to ongoing work

## 6. Explicit Constraints (Verbatim Only)
- Include ONLY active constraints explicitly stated by the user or existing AGENTS.md context
- Quote constraints verbatim when quoting a constraint
- Do NOT invent, add, or modify constraints
- Do not paste full AGENTS.md, system/developer messages, or long policy blocks; cite the source path/name and quote only decisive clauses
- If no explicit constraints exist, write "None"

## 7. Agent Verification State (Critical for Reviewers)
- **Current Agent**: What agent is running (momus, oracle, etc.)
- **Verification Progress**: Files already verified/validated
- **Pending Verifications**: Files still needing verification
- **Previous Rejections**: If reviewer agent, what was rejected and why
- **Acceptance Status**: Current state of review process

This section is CRITICAL for reviewer agents (momus, oracle) to maintain continuity.

## 8. Delegated Agent Sessions
- List active/recent background agent tasks that still matter
- For each: agent name, category, status, short description, and **task_id**
- **RESUME, DON'T RESTART.** Each listed delegated task retains full context. After compaction, use \`task_id\` to continue existing delegated work instead of spawning new tasks. This saves tokens, preserves learned context, and prevents duplicate work.

This context is critical for maintaining continuity after compaction.
`

// ---------------------------------------------------------------------------
// Delegated session history (V1 TaskHistory.formatForCompaction parity)
// ---------------------------------------------------------------------------

const MAX_COMPACTION_ENTRIES = 20
const MAX_COMPACTION_DESCRIPTION_CHARS = 240
const MAX_COMPACTION_TOTAL_CHARS = 6_000
const COMPACTION_TRUNCATION_SUFFIX = "... [truncated]"

/** V1 `compactInline`: collapse inline whitespace, neutralize backticks, truncate. */
function compactInline(value, maxChars) {
  const normalized = String(value ?? "")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/`/g, "'")
    .trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  const keepChars = Math.max(0, maxChars - COMPACTION_TRUNCATION_SUFFIX.length)
  return `${normalized.slice(0, keepChars).trimEnd()}${COMPACTION_TRUNCATION_SUFFIX}`
}

function joinedLength(lines) {
  return lines.reduce((total, line, index) => total + line.length + (index === 0 ? 0 : 1), 0)
}

function appendWithinBudget(lines, line, maxChars) {
  const currentLength = joinedLength(lines)
  const separatorLength = lines.length === 0 ? 0 : 1
  if (currentLength + separatorLength + line.length > maxChars) {
    return false
  }
  lines.push(line)
  return true
}

function appendBudgetSummary(lines, omittedCount, maxChars) {
  const summary = `- ${omittedCount} delegated sessions omitted to stay within compaction budget.`
  if (appendWithinBudget(lines, summary, maxChars)) {
    return
  }
  while (lines.length > 0 && !appendWithinBudget(lines, summary, maxChars)) {
    lines.pop()
  }
}

/**
 * Map a background-manager style record to the V1 compaction entry shape.
 * `prompt` supplies the description when no explicit description is present
 * (V1 `compactInline` then collapses and truncates it); `resultStatus` wins
 * over `status` when both exist.
 */
function toCompactionEntry(record) {
  const explicitDescription = typeof record?.description === "string" && record.description.length > 0
    ? record.description
    : undefined
  const promptDescription = typeof record?.prompt === "string" ? record.prompt : undefined
  return {
    id: record?.taskId ?? record?.id,
    sessionID: record?.sessionID,
    agent: record?.agent ?? record?.subagentType ?? "",
    description: explicitDescription ?? promptDescription ?? "",
    status: record?.resultStatus ?? record?.status ?? "unknown",
    category: record?.category,
  }
}

function formatCompactionEntry(entry, maxDescriptionChars) {
  const description = compactInline(entry.description, maxDescriptionChars)
  const parts = [
    `- **${compactInline(entry.agent, 80)}**`,
    entry.category ? `[${compactInline(entry.category, 60)}]` : "",
    `(${entry.status})`,
    ` task_id: \`${compactInline(entry.id, 120)}\``,
    description ? `: ${description}` : "",
    entry.sessionID ? ` | session: \`${compactInline(entry.sessionID, 120)}\`` : "",
  ]
  return parts.filter((part) => part.length > 0).join("")
}

/**
 * Format delegated session records for the compaction prompt, mirroring V1
 * `TaskHistory.formatForCompaction`: the most recent 20 entries are formatted
 * (oldest first), older entries become a summary line, and the whole block is
 * bounded to 6000 characters with a budget summary when lines are dropped.
 *
 * Returns `null` for an empty list (V1 parity), so a caller can append nothing.
 */
export function formatDelegatedSessionHistory(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null
  }
  const maxEntries = Number.isInteger(options?.maxEntries) ? options.maxEntries : MAX_COMPACTION_ENTRIES
  const maxDescriptionChars = Number.isInteger(options?.maxDescriptionChars)
    ? options.maxDescriptionChars
    : MAX_COMPACTION_DESCRIPTION_CHARS
  const maxTotalChars = Number.isInteger(options?.maxTotalChars) ? options.maxTotalChars : MAX_COMPACTION_TOTAL_CHARS

  const mapped = entries.map(toCompactionEntry)
  const recent = mapped.slice(-maxEntries)
  const olderOmittedCount = mapped.length - recent.length
  const lines = []

  if (olderOmittedCount > 0) {
    lines.push(`- ${olderOmittedCount} older delegated sessions omitted from compaction summary.`)
  }

  let budgetOmittedCount = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index]
    if (!entry) continue
    const line = formatCompactionEntry(entry, maxDescriptionChars)
    if (!appendWithinBudget(lines, line, maxTotalChars)) {
      budgetOmittedCount = index + 1
      break
    }
  }

  if (budgetOmittedCount > 0) {
    appendBudgetSummary(lines, budgetOmittedCount, maxTotalChars)
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Compaction context block (V1 inject() composition)
// ---------------------------------------------------------------------------

/**
 * Build the injected block: the compaction prompt, plus the delegated-session
 * history section when history is present. Mirrors V1 `inject()` exactly, whose
 * append carries a leading and a trailing newline.
 */
export function buildCompactionContextBlock({ history } = {}) {
  let block = COMPACTION_CONTEXT_PROMPT
  if (history) {
    block += `\n### Active/Recent Delegated Sessions\n${history}\n`
  }
  return block
}

// ---------------------------------------------------------------------------
// Provider request classification (fake-openai-native-delegation heuristics)
// ---------------------------------------------------------------------------

const TITLE_SYSTEM_MARKER = "You are a title generator"
const COMPACTION_PROMPT_PATTERN = /^(You MUST summarize|Update the existing checkpoint|The previous response did not fill)/
const PROVIDER_REQUEST_KINDS = new Set(["title", "compaction", "child", "other"])

function detectShape(body) {
  if (Array.isArray(body?.messages)) return "chat"
  if (Array.isArray(body?.input)) return "responses"
  return undefined
}

/** Text of a chat message or a responses input item (string content or parts). */
function itemText(item) {
  if (typeof item?.content === "string") return item.content
  if (Array.isArray(item?.content)) {
    return item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
  }
  if (typeof item?.text === "string") return item.text
  if (typeof item?.output === "string") return item.output
  return ""
}

function collectSystemText(items) {
  if (!Array.isArray(items)) return ""
  return items
    .filter((item) => item?.role === "system")
    .map((item) => itemText(item))
    .join(" ")
}

function lastUserText(items) {
  if (!Array.isArray(items)) return ""
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.role === "user") return itemText(item)
  }
  return ""
}

/**
 * Classify a provider request as one of "title" | "compaction" | "child" |
 * "other". An explicit `kind` wins. Otherwise the request is matched by shape:
 * a chat/`messages` or responses/`input` body whose system text names the title
 * generator is "title"; a body whose last user message begins with one of the
 * V1 compaction prefixes is "compaction"; anything else (including the child
 * marker) is "other".
 */
export function classifyProviderRequest({ body, kind } = {}) {
  if (typeof kind === "string" && PROVIDER_REQUEST_KINDS.has(kind)) {
    return kind
  }
  const shape = detectShape(body)
  if (shape === "chat") {
    if (collectSystemText(body.messages).includes(TITLE_SYSTEM_MARKER)) return "title"
    if (COMPACTION_PROMPT_PATTERN.test(lastUserText(body.messages))) return "compaction"
    return "other"
  }
  if (shape === "responses") {
    if (collectSystemText(body.input).includes(TITLE_SYSTEM_MARKER)) return "title"
    if (COMPACTION_PROMPT_PATTERN.test(lastUserText(body.input))) return "compaction"
    return "other"
  }
  return "other"
}

// ---------------------------------------------------------------------------
// A1: messages hook
// ---------------------------------------------------------------------------

/**
 * Build the A1 messages hook. It appends the compaction context block to a live
 * `event.messages` array exactly once. V2 message-info `content` is an array of
 * typed parts (a string content crashes `SessionCompaction.compact` in
 * `SessionModelRequest.prepare`), so the block is pushed as one text part and
 * the idempotency scan reads both string and part content.
 */
export function createNativeCompactionContextHook({
  buildBlock = buildCompactionContextBlock,
  getHistory,
} = {}) {
  return async (event) => {
    if (!event || !Array.isArray(event.messages)) return
    if (messagesContainMarker(event.messages)) return
    const history = typeof getHistory === "function"
      ? getHistory(typeof event.sessionID === "string" ? event.sessionID : undefined)
      : undefined
    event.messages.push({
      role: "user",
      content: [{ type: "text", text: buildBlock({ history }) }],
    })
  }
}

/** True when any message already carries the marker in string or part content. */
function messagesContainMarker(messages) {
  return messages.some((message) => itemText(message).includes(COMPACTION_CONTEXT_MARKER))
}

// ---------------------------------------------------------------------------
// A2: request step
// ---------------------------------------------------------------------------

function bodyContainsMarker(body, shape) {
  if (shape === "chat" && Array.isArray(body?.messages)) {
    return body.messages.some((message) => itemText(message).includes(COMPACTION_CONTEXT_MARKER))
  }
  if (shape === "responses" && Array.isArray(body?.input)) {
    return body.input.some((item) => itemText(item).includes(COMPACTION_CONTEXT_MARKER))
  }
  return false
}

/**
 * Build the A2 request step (`{ name, run }`). `run` injects the compaction
 * context block only into a compaction request: the classification must be
 * "compaction" and the block must not already be present. Chat bodies receive a
 * string user message; responses bodies receive an `input_text` user item. Any
 * other request is left untouched.
 */
export function createCompactionContextStep({ buildBlock = buildCompactionContextBlock } = {}) {
  return {
    name: "compaction-context-injector",
    run: async (context) => {
      const body = context?.body
      const kind = context?.kind ?? context?.input?.kind
      if (classifyProviderRequest({ body, kind }) !== "compaction") {
        return undefined
      }
      const shape = context?.shape ?? detectShape(body)
      if (shape !== "chat" && shape !== "responses") {
        return undefined
      }
      if (bodyContainsMarker(body, shape)) {
        return undefined
      }
      const block = buildBlock({})
      if (shape === "chat") {
        body.messages.push({ role: "user", content: block })
      } else {
        body.input.push({ role: "user", content: [{ type: "input_text", text: block }] })
      }
      return { injected: true, shape, sessionID: context?.sessionID }
    },
  }
}

// ---------------------------------------------------------------------------
// Redundant restoration trigger (event-stream independent)
// ---------------------------------------------------------------------------

/**
 * True when the request is the compaction summary. The V2 event stream is
 * volatile by contract ("a slow consumer overflows and fails the stream, and
 * events during disconnection are missed", opencode.ai/v2/docs/api
 * `event.subscribe`), so the keyword restoration flag must not depend on it:
 * the summary request itself is the authoritative signal.
 */
export function isCompactionSummaryRequest({ body, kind } = {}) {
  return classifyProviderRequest({ body, kind }) === "compaction"
}

/**
 * Redundant restoration trigger for the `http.request` boundary. It calls
 * `mark` (the keyword state's `markNeedsRestoration`) exactly when the request
 * is the compaction summary, so the ultrawork restoration fires even when the
 * event stream dropped the compaction events. Non-compaction requests never
 * mark anything. Errors from `mark` propagate; the wiring isolates them.
 */
export function noteCompactionRestoration({ body, kind, mark } = {}) {
  if (!isCompactionSummaryRequest({ body, kind })) return false
  if (typeof mark === "function") mark()
  return true
}
