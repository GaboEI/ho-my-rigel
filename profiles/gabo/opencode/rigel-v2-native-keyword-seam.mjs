/**
 * Keyword-detector binder for the native OpenCode V2 request boundary.
 *
 * The pure decision core (`rigel-v2-keyword-core.mjs`) owns detection and the
 * state port (`rigel-v2-keyword-state.mjs`) owns the capped session stores.
 * This module is the thin seam between them and the provider body:
 *
 * - it reconstructs the current-turn user text parts for the chat and Responses
 *   shapes (`http.request` carries the whole conversation; V1 scanned the
 *   message being sent, so the newest user message is the current turn);
 * - it runs `decideKeywordInjection` with the routed message bodies and the
 *   session record, and returns the directive plus the state transitions;
 * - it appends the directive to the current user content, mirroring V1's
 *   first-real-user-part append (`text + "\n\n---\n\n" + guidance`).
 *
 * T1 proved `body.messages[role=user].content` is the honored injection target
 * for the live Chat Completions shape; the Responses branch mirrors it
 * defensively and falls back to the system `instructions` boundary.
 */

import {
  ULTRAWORK_PATTERN,
  decideKeywordInjection,
  getUltraworkSource,
  isRealUserTextPart,
} from "./rigel-v2-keyword-core.mjs"
import { createKeywordState } from "./rigel-v2-keyword-state.mjs"

// V1 pushes this synthetic marker, instead of the full guidance, when a live
// ultrawork record replays on a later turn.
export const ULTRAWORK_CONTINUATION_MARKER = "<ultrawork-mode>active</ultrawork-mode>"

/**
 * Text parts of the newest user message. The keyword core applies the
 * synthetic/internal filters to these parts.
 */
export function chatUserParts(messages) {
  if (!Array.isArray(messages)) return []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") continue
    if (typeof message.content === "string") return [{ type: "text", text: message.content }]
    if (!Array.isArray(message.content)) return []
    return message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => ({ type: "text", text: part.text, synthetic: part.synthetic === true }))
  }
  return []
}

/**
 * Text parts of the newest user message in the Responses API `input` array:
 * either a bare string, or `{type:"message", role:"user", content:[...]}` items
 * produced by the V2 request builder.
 */
export function responsesUserParts(body) {
  if (typeof body?.input === "string") return [{ type: "text", text: body.input }]
  if (!Array.isArray(body?.input)) return []
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index]
    if (item?.role !== "user") continue
    if (typeof item.content === "string") return [{ type: "text", text: item.content }]
    if (!Array.isArray(item.content)) return []
    return item.content
      .filter((part) => typeof part?.text === "string" && (part.type === "input_text" || part.type === "text"))
      .map((part) => ({ type: "text", text: part.text }))
  }
  return []
}

/**
 * Exact V1 ultrawork probes (`/\b(?:ultrawork|ulw)\b/i`): confirm the raw body
 * carries the keyword before a persistent ultrawork record is written, so
 * `ultraworker` never seeds one. The keyword core owns the decision itself.
 */
function hasUltraworkKeyword(messages) {
  return chatUserParts(messages).some((part) => ULTRAWORK_PATTERN.test(part.text))
}

function responsesHasUltraworkKeyword(body) {
  return responsesUserParts(body).some((part) => ULTRAWORK_PATTERN.test(part.text))
}

/** Index of the newest user message, the current-turn append target. */
export function currentUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

/**
 * Mirror of V1's first-real-user-part append. Returns false when the message
 * has no writable text slot.
 */
export function appendDirectiveToUserMessage(message, directive) {
  if (!message || typeof directive !== "string" || directive.length === 0) return false
  if (typeof message.content === "string") {
    message.content = `${message.content}\n\n---\n\n${directive}`
    return true
  }
  if (!Array.isArray(message.content)) return false
  const textPart = message.content.find(isRealUserTextPart)
  if (textPart) {
    textPart.text = `${textPart.text}\n\n---\n\n${directive}`
    return true
  }
  message.content.push({ type: "text", text: directive })
  return true
}

/**
 * Responses fallback: append the directive to the newest user input item.
 * Returns false when the body has no writable user input slot, and the caller
 * then keeps the directive at the system `instructions` boundary.
 */
export function appendDirectiveToResponsesInput(body, directive) {
  if (!Array.isArray(body?.input) || typeof directive !== "string" || directive.length === 0) return false
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index]
    if (item?.role !== "user") continue
    if (typeof item.content === "string") {
      item.content = `${item.content}\n\n---\n\n${directive}`
      return true
    }
    if (!Array.isArray(item.content)) return false
    const textPart = item.content.find((part) => (part?.type === "input_text" || part?.type === "text")
      && typeof part.text === "string")
    if (textPart) {
      textPart.text = `${textPart.text}\n\n---\n\n${directive}`
      return true
    }
    item.content.push({ type: "input_text", text: directive })
    return true
  }
  return false
}

/**
 * Build the seam for one request hook. `keywordState` may be injected by the
 * runtime so its event loop can feed `session.compacted` / `session.deleted`;
 * without one the seam owns a private state instance.
 */
export function createKeywordSeam({
  ultraworkPrompt = "",
  ultraworkPrompts,
  keywordMessages,
  keywordState,
  disabledKeywords,
  enabledExpansions,
  defaultUltrawork = false,
} = {}) {
  const state = keywordState ?? createKeywordState()
  const modeMessages = keywordMessages && typeof keywordMessages === "object" ? keywordMessages : {}
  const promptsBySource = ultraworkPrompts && typeof ultraworkPrompts === "object" ? ultraworkPrompts : {}

  /**
   * V1 routes the ultrawork body by source (planner/gpt/gemini/glm/default).
   * A staged per-source body wins; the caller's default body is the fallback,
   * and a missing prompt degrades to no directive rather than a fabricated one.
   */
  function ultraworkBodyFor(source) {
    const candidates = [promptsBySource[source], ultraworkPrompt]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate
    }
    return ""
  }

  function decide({ parts, sessionID, agent, modelID }) {
    const promptSource = getUltraworkSource(agent, modelID)
    const ultraworkBody = ultraworkBodyFor(promptSource)
    const comboBanner = typeof modeMessages.comboBanner === "string" ? modeMessages.comboBanner.trim() : ""
    const messageTexts = {
      ultrawork: ultraworkBody,
      team: typeof modeMessages.team === "string" ? modeMessages.team : "",
      hyperplan: typeof modeMessages.hyperplan === "string" ? modeMessages.hyperplan : "",
      "hyperplan-ultrawork": [comboBanner, ultraworkBody].filter(Boolean).join("\n\n"),
    }
    const decision = decideKeywordInjection({
      parts,
      agent,
      modelID,
      disabledKeywords,
      enabledExpansions,
      messageTexts,
      activeUltrawork: sessionID ? state.getExplicit(sessionID) : undefined,
      defaultUltrawork,
      defaultModeInjected: sessionID ? state.hasDefaultModeInjected(sessionID) : false,
    })
    if (decision.clearExplicit && sessionID) state.clearSession(sessionID)
    let directive = decision.action === "inject" ? decision.allMessages : ""
    if (!directive && decision.continuationMarker) directive = ULTRAWORK_CONTINUATION_MARKER
    // The manifest default mode keeps the routed ultrawork body on every root
    // request, like V1's default-mode system prompt, independent of the keyword
    // decision. It never duplicates guidance the decision already carries.
    if (defaultUltrawork) {
      const body = ultraworkBodyFor(decision.promptSource)
      if (body && !directive.includes(body)) directive = [body, directive].filter(Boolean).join("\n\n")
    }
    return { decision, directive }
  }

  /** The core decided; this confirms the raw body before a record is written. */
  function confirmExplicit({ decision, body, isChatShape }) {
    return decision.replayUltrawork
      || (isChatShape ? hasUltraworkKeyword(body?.messages) : responsesHasUltraworkKeyword(body))
  }

  /** Apply the decision's state transitions. */
  function commit({ decision, sessionID, shouldPersist }) {
    if (!sessionID) return
    if (decision.rememberDefaultMode) state.rememberDefaultModeInjected(sessionID)
    if (shouldPersist) state.rememberExplicit(sessionID, { source: decision.promptSource })
  }

  return { state, decide, confirmExplicit, commit, ultraworkBodyFor }
}
