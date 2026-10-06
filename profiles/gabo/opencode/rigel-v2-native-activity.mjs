/**
 * Native V2 session-event vocabularies.
 *
 * V1's `plugin/event.ts` treated the `message.updated`, `message.removed` and
 * `message.part.*` family as session activity: tmux pane stability, idle
 * notification cancellation and todo-continuation response observation all
 * bumped on those events.
 *
 * OpenCode V2 (verified against v2.0.22 on the isolated laboratory) does NOT
 * emit those events. A live `ctx.event.subscribe` capture over real turns, a
 * real message-removal (revert) and a real failed tool call shows an EMPTY
 * `message.*` set; the activity is carried by the `session.*` stream instead.
 * Consumers that keep listening for `message.*` are dead no-ops.
 *
 * V1 did not treat all activity the same, so neither does V2. Three distinct
 * vocabularies are kept separate on purpose:
 *
 * - OUTPUT: the session produced assistant output (text, reasoning, tool
 *   calls, tool output progress, tool completion, including a failed tool).
 *   This is the V2 analogue of the V1 `message.part.delta` / assistant
 *   `message.updated` / `message.part.updated` activity, and it is what a
 *   continuation response observation rides.
 * - USER: a NEW inbound user message (the V1 `message.updated` with
 *   `role === "user"`).
 * - MUTATION: a message removal / revert. V1 `message.removed` was session
 *   activity for tmux and notifications, but it is NOT assistant output and it
 *   must never be observed as a continuation response.
 *
 * `V2_ACTIVITY_EVENT_TYPES` is the union used by consumers that only need
 * "something happened" (tmux pane stability, idle-notification cancellation).
 */

/** Assistant output / response: model text, reasoning, and tool activity. */
export const V2_OUTPUT_ACTIVITY_EVENT_TYPES = Object.freeze([
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
])

/** A new inbound user message (V1 `message.updated` with `role === "user"`). */
export const V2_USER_ACTIVITY_EVENT_TYPES = Object.freeze([
  "session.inbox.enqueued",
  "session.inbox.delivered",
])

/**
 * A message removal / revert (V1 `message.removed`). A mutation is session
 * activity, but it is not assistant output.
 */
export const V2_MUTATION_ACTIVITY_EVENT_TYPES = Object.freeze([
  "session.revert.staged",
  "session.revert.cleared",
])

/** General session activity: any output, any user message, any mutation. */
export const V2_ACTIVITY_EVENT_TYPES = Object.freeze([
  ...V2_OUTPUT_ACTIVITY_EVENT_TYPES,
  ...V2_USER_ACTIVITY_EVENT_TYPES,
  ...V2_MUTATION_ACTIVITY_EVENT_TYPES,
])

export function isV2OutputActivity(type) {
  return typeof type === "string" && V2_OUTPUT_ACTIVITY_EVENT_TYPES.includes(type)
}

export function isV2UserActivity(type) {
  return typeof type === "string" && V2_USER_ACTIVITY_EVENT_TYPES.includes(type)
}

/**
 * Resolve a V2 event's session id tolerantly. The plugin event stream carries
 * the id under `data.sessionID`; some consumers receive an already-enriched
 * event with a top-level `sessionID`; older shapes use `properties.sessionID`.
 * Returns undefined when no string id is present.
 */
export function resolveV2EventSessionID(event) {
  const value = event?.sessionID
    ?? event?.data?.sessionID
    ?? event?.data?.session?.id
    ?? event?.properties?.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}
