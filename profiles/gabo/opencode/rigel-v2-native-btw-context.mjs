/**
 * Oh My Rigel native OpenCode V2 BTW parent-context injector.
 *
 * Server-side port of the V1 owner
 * `packages/omo-opencode/src/features/btw-side/context-injector.ts` (+
 * `server-session-registry.ts`): when a session carries the BTW side metadata
 * (`omo_btw_side`), the side's own turn is prefixed with a bounded copy of the
 * parent conversation and a read-only boundary block, and a durable receipt is
 * written under `$XDG_STATE_HOME/oh-my-rigel/btw-injection.json`.
 *
 * V2 seam: the official `context` hook, registered through
 * `context.session.hook("context", handler)`. The handler receives the mutable
 * provider request event `{ sessionID, agent, model, system, messages, tools,
 * options }`.
 *
 * Isolation contract (pinned by the unit tests):
 *   - a session WITHOUT the BTW metadata is left byte-identical and writes no
 *     receipt (the hook returns false before touching the event);
 *   - a session WITH the metadata gets the bounded parent context (V1 caps:
 *     <=64 messages, <=64KB serialized) and exactly ONE boundary block;
 *   - repeated passes are idempotent: a boundary already present short-circuits
 *     so the block never stacks.
 *
 * Every effect is contained and logged; a failure never throws into the host.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  BTW_BOUNDARY_SENTINEL,
  boundBtwParentContext,
  buildBtwBoundaryText,
  getBtwSideMetadata,
  messageContainsBtwBoundary,
  serializedMessageBytes,
} from "./rigel-v2-btw-core.mjs"

export const BTW_CONTEXT_PLUGIN_ID = "oh-my-rigel.btw-context"
export const BTW_INJECTION_RECEIPT_FILE = "btw-injection.json"

/** `$XDG_STATE_HOME/oh-my-rigel/btw-injection.json` with the profile-kit homedir fallback. */
export function resolveBtwReceiptPath(env = process.env, home = homedir()) {
  const base = typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state")
  return join(base, "oh-my-rigel", BTW_INJECTION_RECEIPT_FILE)
}

function defaultLog(entry) {
  console.error(`[oh-my-rigel] BTW context: ${JSON.stringify(entry)}`)
}

/**
 * Atomically write the durable injection receipt. Returns false (never throws)
 * when the write fails, so a receipt failure cannot break a turn.
 */
export function writeBtwInjectionReceipt(receiptPath, receipt, log = defaultLog) {
  const temporary = `${receiptPath}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 })
    writeFileSync(
      temporary,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...receipt }, null, 2)}\n`,
      { mode: 0o600 },
    )
    renameSync(temporary, receiptPath)
    return true
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // best-effort cleanup; the receipt failure below is the reported one
    }
    log({ event: "receipt-write-failed", error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

/** Unwrap an SDK/domain envelope: `{ data }` or the value itself. */
function unwrap(response) {
  return response && typeof response === "object" && "data" in response ? response.data : response
}

function normalizeMessages(response) {
  const data = unwrap(response)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.messages)) return data.messages
  return []
}

/**
 * Build the `context`-hook handler. `readSession`, `readParentMessages` and
 * `writeReceipt` are injected so the unit tests drive the contract without a
 * host. Returns the boolean "injected" outcome.
 */
export function createBtwContextInjector(deps = {}) {
  const log = typeof deps.log === "function" ? deps.log : defaultLog

  return async (event) => {
    if (!event || typeof event !== "object") return false
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
    if (!sessionID) return false

    let session
    try {
      session = await deps.readSession(sessionID)
    } catch (error) {
      log({ event: "session-read-failed", sessionID, error: error instanceof Error ? error.message : String(error) })
      return false
    }
    const metadata = getBtwSideMetadata(session)
    if (!metadata) return false

    if (Array.isArray(event.messages) && event.messages.some(messageContainsBtwBoundary)) return false
    if (Array.isArray(event.system) && event.system.some((part) => typeof part?.text === "string" && part.text.includes(BTW_BOUNDARY_SENTINEL))) {
      return false
    }

    let parentMessages = []
    try {
      parentMessages = normalizeMessages(await deps.readParentMessages(metadata.parent_session_id))
    } catch (error) {
      log({
        event: "parent-context-read-failed",
        sessionID,
        parentSessionID: metadata.parent_session_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const bounded = boundBtwParentContext(parentMessages)

    const system = Array.isArray(event.system) ? event.system : []
    system.unshift({ type: "text", text: buildBtwBoundaryText(metadata.parent_session_id) })
    event.system = system

    if (bounded.length > 0) {
      const messages = Array.isArray(event.messages) ? event.messages : []
      event.messages = [...bounded, ...messages]
    }

    const receipt = {
      sessionID,
      injected: true,
      parentSessionID: metadata.parent_session_id,
      messages: bounded.length,
      bytes: serializedMessageBytes(bounded),
    }
    try {
      await deps.writeReceipt(receipt)
    } catch (error) {
      log({ event: "receipt-failed", sessionID, error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
}

/**
 * Build the installer. `install(context)` registers the `context` hook and
 * returns its registration (or undefined when the host exposes no hook seam).
 * Test seams (`readSession`, `readParentMessages`, `writeReceipt`, `log`,
 * `receiptPath`) may be supplied as overrides.
 */
export function createBtwContextInstaller(overrides = {}) {
  return {
    id: BTW_CONTEXT_PLUGIN_ID,
    async install(context) {
      if (typeof context?.session?.hook !== "function") return undefined

      const readSession =
        typeof overrides.readSession === "function"
          ? overrides.readSession
          : async (sessionID) => {
              if (typeof context?.session?.get === "function") return unwrap(await context.session.get({ sessionID }))
              if (typeof context?.client?.session?.get === "function") {
                return unwrap(await context.client.session.get({ path: { id: sessionID } }))
              }
              return undefined
            }

      const readParentMessages =
        typeof overrides.readParentMessages === "function"
          ? overrides.readParentMessages
          : async (parentSessionID) => {
              if (typeof context?.session?.context === "function") {
                return normalizeMessages(await context.session.context({ sessionID: parentSessionID }))
              }
              if (typeof context?.client?.session?.messages === "function") {
                return normalizeMessages(await context.client.session.messages({ path: { id: parentSessionID } }))
              }
              return []
            }

      const log = typeof overrides.log === "function" ? overrides.log : defaultLog
      const receiptPath = overrides.receiptPath ?? resolveBtwReceiptPath()
      const writeReceipt =
        typeof overrides.writeReceipt === "function"
          ? overrides.writeReceipt
          : (receipt) => writeBtwInjectionReceipt(receiptPath, receipt, log)

      const handler = createBtwContextInjector({ readSession, readParentMessages, writeReceipt, log })
      return await context.session.hook("context", handler)
    },
  }
}

export default createBtwContextInstaller()
