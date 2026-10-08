/**
 * Oh My Rigel BTW side-conversation core, V2 native.
 *
 * Pure, deterministic port of the V1 owner
 * `packages/omo-opencode/src/features/btw-side/`:
 *   - metadata.ts             -> BTW_SIDE_METADATA_KEY / _VERSION, create/parse/get
 *   - parent-context-budget.ts-> BTW_PARENT_CONTEXT_MAX_BYTES / _MESSAGES, boundBtwParentContext
 *   - context-injector.ts     -> BTW_BOUNDARY_SENTINEL, boundary text, boundary detection
 *   - tui-controller.ts       -> createBtwController (phases, retained sides, tombstones)
 *   - tui-controller-types.ts -> record/state/dependency shapes
 *   - tui-side-start.ts       -> prepareBtwSideStart
 *   - tui-side-removal.ts     -> abort/delete helpers
 *   - tui-prompt-queue.ts     -> createBtwPromptQueue
 *   - tui-escape-return.ts    -> createBtwEscapeReturn
 *   - tui-picker-options.ts   -> parseBtwPickerValue / buildBtwPickerOptions
 *   - tui-session-catalog.ts  -> classifyBtwSessionCatalog (pure half only)
 *   - btw-command-draft.ts    -> parseBtwQuestion / isBtwCommandDraft / findBtwBoundaryMessageID
 *
 * This module has NO imports and touches no host state: it is the seam the thin
 * V2 runtime adapters (`rigel-v2-native-btw-context.mjs`,
 * `rigel-v2-native-cli-btw.mjs`) call into. Everything here is deterministic so
 * the contract can be pinned by unit tests.
 *
 * V2 adaptation: the V1 budget/injection operated on the SDK `{ info, parts }`
 * message shape. V2's `context` hook carries provider-shaped messages
 * (`{ role, content }` with `content` a string or an array of `{ type, text }`
 * parts). `boundBtwParentContext` therefore counts and truncates on the V2
 * shape while preserving the V1 caps and the V1 truncation marker.
 */

// ---------------------------------------------------------------------------
// Session metadata (V1 metadata.ts)
// ---------------------------------------------------------------------------

export const BTW_SIDE_METADATA_KEY = "omo_btw_side"
export const BTW_SIDE_METADATA_VERSION = 1

export function createBtwSideMetadata(args) {
  return {
    version: BTW_SIDE_METADATA_VERSION,
    parent_session_id: String(args?.parentSessionID ?? ""),
    boundary_message_id: String(args?.boundaryMessageID ?? ""),
  }
}

export function parseBtwSideMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  if (value.version !== BTW_SIDE_METADATA_VERSION) return undefined
  if (typeof value.parent_session_id !== "string" || value.parent_session_id.length === 0) return undefined
  if (typeof value.boundary_message_id !== "string" || value.boundary_message_id.length === 0) return undefined
  return {
    version: BTW_SIDE_METADATA_VERSION,
    parent_session_id: value.parent_session_id,
    boundary_message_id: value.boundary_message_id,
  }
}

export function getBtwSideMetadata(session) {
  return parseBtwSideMetadata(session?.metadata?.[BTW_SIDE_METADATA_KEY])
}

// ---------------------------------------------------------------------------
// Parent-context budget (V1 parent-context-budget.ts)
// ---------------------------------------------------------------------------

export const BTW_PARENT_CONTEXT_MAX_BYTES = 64 * 1024
export const BTW_PARENT_CONTEXT_MAX_MESSAGES = 64

const TRUNCATION_MARKER = "[Earlier parent message content truncated]\n"
const encoder = new TextEncoder()

/** Serialized UTF-8 byte size of a message list, exactly as the budget counts it. */
export function serializedMessageBytes(messages) {
  return encoder.encode(JSON.stringify(messages)).byteLength
}

function cloneMessage(message) {
  if (!message || typeof message !== "object") return message
  return {
    ...message,
    ...(Array.isArray(message.content)
      ? { content: message.content.map((part) => (part && typeof part === "object" ? { ...part } : part)) }
      : {}),
  }
}

/** The concatenated text of a V2 provider-shaped message. */
export function btwMessageText(message) {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
  }
  return ""
}

/** Keep the tail of a message's text so the message alone fits `maxBytes`. */
function truncatedMessage(message, maxBytes) {
  const text = btwMessageText(message)
  const base = { ...message, content: [] }
  const candidate = (tailCharacters) => ({
    ...base,
    content: [
      {
        type: "text",
        text: `${TRUNCATION_MARKER}${text.slice(-tailCharacters)}`,
        synthetic: true,
      },
    ],
  })
  let best = base
  let low = 0
  let high = text.length
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const attempt = candidate(middle)
    if (serializedMessageBytes([attempt]) <= maxBytes) {
      best = attempt
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/**
 * Bound the parent transcript: at most `BTW_PARENT_CONTEXT_MAX_MESSAGES`
 * messages and at most `BTW_PARENT_CONTEXT_MAX_BYTES` serialized bytes, keeping
 * the most recent context and truncating the oldest surviving message's text
 * when it alone would exceed the byte cap. Deterministic; never mutates input.
 */
export function boundBtwParentContext(messages) {
  const list = Array.isArray(messages) ? messages : []
  const candidates = list.slice(-BTW_PARENT_CONTEXT_MAX_MESSAGES)
  const bounded = []
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = cloneMessage(candidates[index])
    if (serializedMessageBytes([message, ...bounded]) <= BTW_PARENT_CONTEXT_MAX_BYTES) {
      bounded.unshift(message)
      continue
    }
    if (bounded.length === 0) {
      bounded.unshift(truncatedMessage(message, BTW_PARENT_CONTEXT_MAX_BYTES))
    }
    break
  }
  return bounded
}

// ---------------------------------------------------------------------------
// Boundary marker (V1 context-injector.ts)
// ---------------------------------------------------------------------------

export const BTW_BOUNDARY_SENTINEL = "<omo-btw-boundary>"

export const BTW_BOUNDARY_TEXT = `${BTW_BOUNDARY_SENTINEL}
Treat all earlier messages as read-only background from the main conversation.
Answer only the side conversation that follows.
Do not mutate files or external state unless the side request explicitly asks for it.
Do not delegate work to subagents from this side conversation.`

/** True when a message already carries the BTW boundary (idempotence guard). */
export function messageContainsBtwBoundary(message) {
  const content = message?.content
  if (typeof content === "string") return content.includes(BTW_BOUNDARY_SENTINEL)
  if (Array.isArray(content)) {
    return content.some((part) => typeof part?.text === "string" && part.text.includes(BTW_BOUNDARY_SENTINEL))
  }
  return false
}

/** Boundary block carrying the parent session id, for observability. */
export function buildBtwBoundaryText(parentSessionID) {
  return `${BTW_BOUNDARY_TEXT}\nParent session: ${String(parentSessionID ?? "")}`
}

// ---------------------------------------------------------------------------
// Prompt queue (V1 tui-prompt-queue.ts)
// ---------------------------------------------------------------------------

export function createBtwPromptQueue() {
  const promptRefs = new Map()
  const pendingQuestions = new Map()

  return {
    attach(sessionID, promptRef) {
      if (!promptRef) {
        promptRefs.delete(sessionID)
        return
      }
      promptRefs.set(sessionID, promptRef)
      const pendingQuestion = pendingQuestions.get(sessionID)
      if (pendingQuestion === undefined) return
      pendingQuestions.delete(sessionID)
      promptRef.set(pendingQuestion)
      promptRef.submit()
    },
    queue(sessionID, question) {
      pendingQuestions.set(sessionID, question)
    },
    input(sessionID) {
      return promptRefs.get(sessionID)?.input ?? ""
    },
    hasAttachments(sessionID) {
      return promptRefs.get(sessionID)?.hasAttachments ?? false
    },
    clear(sessionID) {
      promptRefs.delete(sessionID)
      pendingQuestions.delete(sessionID)
    },
  }
}

// ---------------------------------------------------------------------------
// Command draft helpers (V1 btw-command-draft.ts)
// ---------------------------------------------------------------------------

const BTW_COMMAND_PATTERN = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/

export function isBtwCommandDraft(input) {
  return /^\/(?:btw|side)(?:\s|$)/.test(String(input ?? "").trimStart())
}

export function parseBtwQuestion(input) {
  const text = String(input ?? "")
  if (text.length === 0) return { consumeDraft: false, question: "" }
  const match = BTW_COMMAND_PATTERN.exec(text.trim())
  if (!match) return { consumeDraft: false, question: "" }
  return { consumeDraft: true, question: match[1]?.trim() ?? "" }
}

// Tolerant message accessors: V1 `{ info: { id, role, time } }` and the leaner
// V2 `{ id, role, completed }` both resolve.
function messageRole(message) {
  return message?.info?.role ?? message?.role
}
function messageID(message) {
  return message?.info?.id ?? message?.id
}
function messageCompleted(message) {
  return message?.info?.time?.completed ?? message?.time?.completed ?? message?.completed
}

/** The boundary is the last user message, else the last completed message. */
export function findBtwBoundaryMessageID(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (!message) continue
    if (messageRole(message) === "user") return messageID(message)
    if (messageCompleted(message) !== undefined) return messageID(message)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Side-start preparation (V1 tui-side-start.ts)
// ---------------------------------------------------------------------------

export function prepareBtwSideStart(dependencies, promptRef, parentSessionID = dependencies.getCurrentSessionID()) {
  if (!parentSessionID) {
    dependencies.showToast("BTW is unavailable before the session starts.")
    return undefined
  }
  const parentSession = dependencies.getSession(parentSessionID)
  const boundaryMessageID = findBtwBoundaryMessageID(dependencies.getMessages(parentSessionID))
  if (!parentSession || !boundaryMessageID) {
    dependencies.showToast("BTW is unavailable before the session starts.")
    return undefined
  }
  if (promptRef.hasAttachments) {
    dependencies.showToast("BTW supports text-only drafts. Remove attachments before starting BTW.")
    return undefined
  }

  const originalDraft = promptRef.input
  const parsed = parseBtwQuestion(originalDraft)
  const summary = parsed.question.replace(/\s+/g, " ").trim()
  return {
    parentSessionID,
    originalDraft,
    consumeDraft: parsed.consumeDraft,
    question: parsed.question,
    createInput: {
      title: `BTW · ${(summary || "New side").slice(0, 64)}`,
      ...(parentSession.agent ? { agent: parentSession.agent } : {}),
      ...(parentSession.model
        ? { model: { providerID: parentSession.model.providerID, id: parentSession.model.id ?? parentSession.model.modelID } }
        : {}),
      metadata: {
        [BTW_SIDE_METADATA_KEY]: createBtwSideMetadata({ parentSessionID, boundaryMessageID }),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Side removal helpers (V1 tui-side-removal.ts)
// ---------------------------------------------------------------------------

export async function abortBtwSide(args) {
  try {
    await args.abortSession(args.sessionID)
  } catch {
    args.showToast("BTW could not stop the active side turn.")
  }
}

export async function deleteBtwSide(args) {
  try {
    await args.deleteSession(args.sessionID)
    return true
  } catch {
    args.showToast(args.failureMessage)
    return false
  }
}

// ---------------------------------------------------------------------------
// Controller state machine (V1 tui-controller.ts + tui-controller-types.ts)
// ---------------------------------------------------------------------------

export const MAX_DELETED_SESSION_TOMBSTONES = 512

export function createBtwController(dependencies) {
  let currentState = { phase: "closed" }
  let stateGeneration = 0
  let disposed = false
  let skipClosingParentNavigation = false
  const activeCreationOperations = new Set()
  const closedWaiters = new Set()
  const deletedSessionIDs = new Set()
  const retainedSides = new Map()
  const sideNumbers = new Map()
  const promptQueue = createBtwPromptQueue()

  function rememberDeletedSession(sessionID) {
    if (!deletedSessionIDs.has(sessionID) && deletedSessionIDs.size >= MAX_DELETED_SESSION_TOMBSTONES) {
      const oldestSessionID = deletedSessionIDs.values().next().value
      if (oldestSessionID !== undefined) deletedSessionIDs.delete(oldestSessionID)
    }
    deletedSessionIDs.add(sessionID)
  }

  function setState(nextState) {
    currentState = nextState
    stateGeneration += 1
    if (nextState.phase === "closed") {
      for (const resolve of closedWaiters) resolve()
      closedWaiters.clear()
    }
    if (!disposed) dependencies.requestRender()
  }

  function waitUntilClosed() {
    if (currentState.phase === "closed") return Promise.resolve()
    return new Promise((resolve) => {
      closedWaiters.add(resolve)
    })
  }

  function isClosingGeneration(generation) {
    return stateGeneration === generation && currentState.phase === "closing"
  }

  function isCreatingGeneration(generation) {
    return stateGeneration === generation && currentState.phase === "creating"
  }

  function attachPromptRef(sessionID, promptRef) {
    promptQueue.attach(sessionID, promptRef)
  }

  function latestSideForParent(parentSessionID) {
    return [...retainedSides.values()].reverse().find((side) => side.parentSessionID === parentSessionID)
  }

  function stateForSession(sessionID) {
    if (!sessionID) return { phase: "closed" }
    const side = retainedSides.get(sessionID)
    if (side) return { phase: "open", ...side }
    const retained = latestSideForParent(sessionID)
    return retained ? { phase: "open", ...retained } : { phase: "closed" }
  }

  function rootParentForCurrentSession() {
    const currentSessionID = dependencies.getCurrentSessionID()
    if (!currentSessionID) return undefined
    return retainedSides.get(currentSessionID)?.parentSessionID ?? currentSessionID
  }

  async function startFromPrompt(promptRef, parentSessionID = rootParentForCurrentSession()) {
    if (disposed) return false
    if (currentState.phase === "creating" || currentState.phase === "closing") {
      dependencies.showToast(currentState.phase === "creating" ? "BTW is already starting." : "BTW is still closing.")
      return false
    }

    const previousState = currentState
    const prepared = prepareBtwSideStart(dependencies, promptRef, parentSessionID)
    if (!prepared) return false
    const restoreDraftIfUnchanged = () => {
      if (prepared.consumeDraft && promptRef.input.length === 0) promptRef.set(prepared.originalDraft)
    }
    if (prepared.consumeDraft) promptRef.set("")
    setState({ phase: "creating", parentSessionID: prepared.parentSessionID })
    const creatingGeneration = stateGeneration
    let resolveCreationFinished
    const creationFinished = new Promise((resolve) => {
      resolveCreationFinished = resolve
    })
    const creationOperation = { generation: creatingGeneration, finished: creationFinished, restoreDraftIfUnchanged }
    activeCreationOperations.add(creationOperation)

    try {
      const sideSession = await dependencies.createSession(prepared.createInput)
      if (deletedSessionIDs.delete(sideSession.id)) {
        if (!disposed) restoreDraftIfUnchanged()
        if (isCreatingGeneration(creatingGeneration)) setState(previousState)
        return false
      }
      if (disposed || !isCreatingGeneration(creatingGeneration)) {
        if (disposed) {
          setState({ phase: "closed" })
        } else {
          restoreDraftIfUnchanged()
          setState(previousState)
        }
        try {
          await dependencies.deleteSession(sideSession.id)
        } catch {
          dependencies.showToast("Unable to remove cancelled BTW.")
        }
        return false
      }
      if (prepared.question.length > 0) promptQueue.queue(sideSession.id, prepared.question)
      const retainedSide = { parentSessionID: prepared.parentSessionID, sideSessionID: sideSession.id, owned: true }
      retainedSides.set(sideSession.id, retainedSide)
      setState({ phase: "open", ...retainedSide })
      dependencies.navigateSession(sideSession.id)
      return true
    } catch {
      if (disposed) {
        setState({ phase: "closed" })
        return false
      }
      if (!isCreatingGeneration(creatingGeneration)) {
        restoreDraftIfUnchanged()
        return false
      }
      restoreDraftIfUnchanged()
      setState(previousState)
      dependencies.showToast("Unable to start BTW.")
      return false
    } finally {
      activeCreationOperations.delete(creationOperation)
      resolveCreationFinished()
    }
  }

  function toggle() {
    if (currentState.phase !== "open") return
    const currentSessionID = dependencies.getCurrentSessionID()
    if (currentSessionID === currentState.sideSessionID) {
      dependencies.navigateSession(currentState.parentSessionID)
      return
    }
    if (currentSessionID === currentState.parentSessionID) {
      dependencies.navigateSession(currentState.sideSessionID)
    }
  }

  async function close() {
    const currentSessionID = dependencies.getCurrentSessionID()
    const openState = currentSessionID ? retainedSides.get(currentSessionID) : undefined
    if (!openState) return
    skipClosingParentNavigation = false
    const closingState = {
      phase: "closing",
      parentSessionID: openState.parentSessionID,
      sideSessionID: openState.sideSessionID,
      owned: openState.owned,
    }
    setState(closingState)
    const closingGeneration = stateGeneration
    await abortBtwSide({
      sessionID: openState.sideSessionID,
      abortSession: dependencies.abortSession,
      showToast: dependencies.showToast,
    })
    if (!isClosingGeneration(closingGeneration)) return
    if (!skipClosingParentNavigation) dependencies.navigateSession(openState.parentSessionID)
    const deleted = await deleteBtwSide({
      sessionID: openState.sideSessionID,
      deleteSession: dependencies.deleteSession,
      showToast: () => undefined,
      failureMessage: "Unable to close BTW.",
    })
    if (!isClosingGeneration(closingGeneration)) return
    if (!deleted) {
      promptQueue.clear(openState.sideSessionID)
      setState({ phase: "closed" })
      setState(stateForSession(openState.parentSessionID))
      dependencies.showToast("Unable to delete BTW. Delete the abandoned side session manually.")
      return
    }
    retainedSides.delete(openState.sideSessionID)
    sideNumbers.delete(openState.sideSessionID)
    promptQueue.clear(openState.sideSessionID)
    setState({ phase: "closed" })
    setState(stateForSession(openState.parentSessionID))
  }

  async function handleNavigation(sessionID) {
    if (currentState.phase === "creating") {
      if (sessionID !== currentState.parentSessionID) {
        const creatingGeneration = stateGeneration
        for (const operation of activeCreationOperations) {
          if (operation.generation === creatingGeneration) operation.restoreDraftIfUnchanged()
        }
        setState(stateForSession(sessionID))
      }
      return
    }
    if (currentState.phase === "closing") {
      if (sessionID !== currentState.parentSessionID && sessionID !== currentState.sideSessionID) {
        skipClosingParentNavigation = true
      }
      return
    }
    setState(stateForSession(sessionID))
  }

  function handleSessionDeleted(sessionID) {
    rememberDeletedSession(sessionID)
    if (currentState.phase === "creating") {
      if (sessionID === currentState.parentSessionID) {
        setState({ phase: "closed" })
        dependencies.showToast("BTW cancelled because its main session was deleted.")
      }
      return
    }
    const deletedSide = retainedSides.get(sessionID)
    if (deletedSide) {
      retainedSides.delete(sessionID)
      sideNumbers.delete(sessionID)
      promptQueue.clear(sessionID)
      if (dependencies.getCurrentSessionID() === sessionID) dependencies.navigateSession(deletedSide.parentSessionID)
      setState(stateForSession(deletedSide.parentSessionID))
      return
    }
    const detachedSides = [...retainedSides.values()].filter((side) => side.parentSessionID === sessionID)
    if (detachedSides.length > 0) {
      const closingSideID =
        currentState.phase === "closing" && sessionID === currentState.parentSessionID
          ? currentState.sideSessionID
          : undefined
      for (const side of detachedSides) {
        if (side.sideSessionID === closingSideID) continue
        const sideNumber = sideNumbers.get(side.sideSessionID)
        retainedSides.delete(side.sideSessionID)
        sideNumbers.delete(side.sideSessionID)
        promptQueue.clear(side.sideSessionID)
        void deleteBtwSide({
          sessionID: side.sideSessionID,
          deleteSession: dependencies.deleteSession,
          showToast: dependencies.showToast,
          failureMessage: "Unable to delete BTW after Main was removed. Delete the abandoned side session manually.",
        }).then((deleted) => {
          if (deleted || disposed) return
          retainedSides.set(side.sideSessionID, side)
          if (sideNumber !== undefined) sideNumbers.set(side.sideSessionID, sideNumber)
          if (dependencies.getCurrentSessionID() === side.sideSessionID) setState(stateForSession(side.sideSessionID))
        })
      }
      if (closingSideID) skipClosingParentNavigation = true
      else setState({ phase: "closed" })
      dependencies.showToast("BTW detached because its main session was deleted.")
    }
  }

  function canCloseCurrentSide() {
    const currentSessionID = dependencies.getCurrentSessionID()
    const currentSide = currentSessionID ? retainedSides.get(currentSessionID) : undefined
    if (!currentSide) return false
    return promptQueue.input(currentSide.sideSessionID).length === 0 && !promptQueue.hasAttachments(currentSide.sideSessionID)
  }

  function adopt(parentSessionID, sideSessionID, sideNumber) {
    const retainedSide = { parentSessionID, sideSessionID, owned: false }
    retainedSides.set(sideSessionID, retainedSide)
    if (sideNumber !== undefined) sideNumbers.set(sideSessionID, sideNumber)
    if (dependencies.getCurrentSessionID() === sideSessionID) setState({ phase: "open", ...retainedSide })
  }

  function returnToParent() {
    const currentSessionID = dependencies.getCurrentSessionID()
    const currentSide = currentSessionID ? retainedSides.get(currentSessionID) : undefined
    if (!currentSide) return
    dependencies.navigateSession(currentSide.parentSessionID)
    setState({ phase: "open", ...currentSide })
  }

  return {
    state: () => currentState,
    sides: () => [...retainedSides.values()],
    side: (sessionID) => retainedSides.get(sessionID),
    sideNumber: (sessionID) => sideNumbers.get(sessionID),
    rootParent: (sessionID) => retainedSides.get(sessionID)?.parentSessionID ?? sessionID,
    startFromPrompt,
    attachPromptRef,
    toggle,
    close,
    returnToParent,
    handleNavigation,
    handleSessionDeleted,
    canCloseCurrentSide,
    adopt,
    waitUntilClosed,
    isSessionTombstoned: (sessionID) => deletedSessionIDs.has(sessionID),
    tombstoneCount: () => deletedSessionIDs.size,
    dispose: async () => {
      disposed = true
      const pendingCreations = [...activeCreationOperations].map((operation) => operation.finished)
      if (currentState.phase === "creating") {
        setState({ phase: "closed" })
      } else if (currentState.phase === "closing") {
        skipClosingParentNavigation = true
        await waitUntilClosed()
        setState({ phase: "closed" })
      } else if (currentState.phase === "open") {
        setState({ phase: "closed" })
      }
      await Promise.all(pendingCreations)
    },
  }
}

// ---------------------------------------------------------------------------
// Escape-return (V1 tui-escape-return.ts)
// ---------------------------------------------------------------------------

export const DOUBLE_ESCAPE_MAX_INTERVAL_MS = 1_000

export function createBtwEscapeReturn(args) {
  const now = args.now ?? Date.now
  let firstEscapeAt

  function reset() {
    firstEscapeAt = undefined
  }

  function handle(context) {
    if (context?.event?.eventType !== "press" || context?.event?.name !== "escape") {
      if (context?.event?.eventType !== "release") reset()
      return false
    }
    if (args.isDialogOpen() || !args.isCurrentSideIdle()) {
      reset()
      return false
    }
    const pressedAt = now()
    if (firstEscapeAt === undefined || pressedAt - firstEscapeAt > DOUBLE_ESCAPE_MAX_INTERVAL_MS) {
      firstEscapeAt = pressedAt
      return false
    }

    reset()
    args.clearPending()
    context.consume?.({ preventDefault: true, stopPropagation: true })
    args.returnToParent()
    return true
  }

  return { handle, reset }
}

// ---------------------------------------------------------------------------
// Picker options (V1 tui-picker-options.ts)
// ---------------------------------------------------------------------------

export const BTW_PICKER_SESSION_PREFIX = "session:"
export const BTW_PICKER_NEW_PREFIX = "new:"

function sessionValue(sessionID) {
  return `${BTW_PICKER_SESSION_PREFIX}${sessionID}`
}

function sideSummary(title) {
  const summary = String(title ?? "").replace(/^BTW\s*·\s*/, "").trim()
  return summary || "Untitled side"
}

export function parseBtwPickerValue(value) {
  const text = String(value ?? "")
  if (text.startsWith(BTW_PICKER_SESSION_PREFIX)) {
    const sessionID = text.slice(BTW_PICKER_SESSION_PREFIX.length)
    return sessionID ? { type: "session", sessionID } : undefined
  }
  if (text.startsWith(BTW_PICKER_NEW_PREFIX)) {
    const parentSessionID = text.slice(BTW_PICKER_NEW_PREFIX.length)
    return parentSessionID ? { type: "new", parentSessionID } : undefined
  }
  return undefined
}

export function buildBtwPickerOptions(catalog, currentSessionID) {
  const mainTitle = String(catalog?.main?.title ?? "").trim() || "Untitled conversation"
  const sides = Array.isArray(catalog?.sides) ? catalog.sides : []
  const options = [
    {
      title: `Main · ${mainTitle}`,
      value: sessionValue(catalog.main.id),
      description: catalog.main.id,
      category: "Main conversation",
    },
    ...(sides.length === 0
      ? [
          {
            title: "No retained BTW sessions yet",
            value: "empty",
            description: "Choose New BTW to start one",
            category: "Retained BTW sessions",
            disabled: true,
          },
        ]
      : []),
    ...sides.map((side, index) => ({
      title: `BTW #${index + 1} · ${sideSummary(side.title)}`,
      value: sessionValue(side.id),
      description: side.id,
      category: "Retained BTW sessions",
    })),
    {
      title: "New BTW",
      value: `${BTW_PICKER_NEW_PREFIX}${catalog.main.id}`,
      description: "Start another retained side conversation",
      category: "Actions",
    },
  ]
  const current = options.some((option) => option.value === sessionValue(currentSessionID))
    ? sessionValue(currentSessionID)
    : sessionValue(catalog.main.id)
  return { options, current }
}

// ---------------------------------------------------------------------------
// Session catalog classification (V1 tui-session-catalog.ts, pure half)
// ---------------------------------------------------------------------------

export function classifyBtwSessionCatalog(sessions, currentSessionID) {
  const list = Array.isArray(sessions) ? sessions : []
  const sessionsByID = new Map(list.map((session) => [session.id, session]))
  const current = sessionsByID.get(currentSessionID)
  if (!current) return undefined

  const rootSessionID = getBtwSideMetadata(current)?.parent_session_id ?? current.id
  const main = sessionsByID.get(rootSessionID)
  if (!main || getBtwSideMetadata(main)) return undefined

  const sides = list
    .filter((session) => getBtwSideMetadata(session)?.parent_session_id === rootSessionID)
    .sort(
      (left, right) =>
        (left?.time?.created ?? 0) - (right?.time?.created ?? 0) || String(left?.id).localeCompare(String(right?.id)),
    )
  return { main, sides }
}

/**
 * Candidate parent sessions for the CLI picker: sessions that are NOT themselves
 * BTW sides. Deterministic, ordered by creation time then id.
 */
export function candidateParentSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  return list
    .filter((session) => session && typeof session.id === "string" && session.id.length > 0 && !getBtwSideMetadata(session))
    .sort(
      (left, right) =>
        (left?.time?.created ?? 0) - (right?.time?.created ?? 0) || String(left?.id).localeCompare(String(right?.id)),
    )
}
