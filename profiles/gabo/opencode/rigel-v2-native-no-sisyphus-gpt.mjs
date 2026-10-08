/**
 * Native V2 port of V1 `packages/omo-opencode/src/hooks/no-sisyphus-gpt/hook.ts`
 * (post-fix upstream 5fd04b590).
 *
 * Effect: when the SESSION agent is `sisyphus` and its model is GPT without a
 * native Sisyphus prompt (`isGptModel && !isGptNativeSisyphusModel && !isGpt6Model`),
 * redirect the session to Hephaestus with a toast. If Hephaestus is NOT in the
 * registered roster (disabled, or its model is not a supported GPT model), keep
 * Sisyphus, show the distinct "unavailable" message, and log - never persist a
 * turn under an agent OpenCode does not know.
 *
 * The V2 availability signal is the REGISTERED roster (`registerNativeAgents`),
 * not V1's `isAgentRegistered`. The redirect uses `context.session.switchAgent`,
 * the same seam `ulw-execute` uses. The notice is an observable side effect
 * (`context.attention.notify`) plus a log, never a prompt-only no-op.
 */

function extractModelName(model) {
  const text = String(model ?? "")
  return text.includes("/") ? (text.split("/").pop() ?? text) : text
}

export function isGptModel(model) {
  return extractModelName(model).toLowerCase().includes("gpt")
}

const GPT_NATIVE_SISYPHUS_RE = /gpt-5[.-](?:(?:3[.-])?codex|[4-9]|\d{2,})/i

export function isGptNativeSisyphusModel(model) {
  return GPT_NATIVE_SISYPHUS_RE.test(extractModelName(model).toLowerCase())
}

export function isGpt6Model(model) {
  return extractModelName(model).toLowerCase().includes("gpt-6")
}

function normalizeAgentKey(agent) {
  const raw = String(agent ?? "").trim().toLocaleLowerCase()
  return raw ? raw.split(/\s+-\s+/)[0].trim() : ""
}

export const SISYPHUS_AGENT_KEY = "sisyphus"
export const HEPHAESTUS_AGENT_KEY = "hephaestus"

export const TOAST_MESSAGE = [
  "Sisyphus works best with Claude Opus, and works fine with Kimi/GLM models.",
  "Do NOT use Sisyphus with GPT (except GPT-5.4, GPT-5.5, and GPT-5.6 Sol, which have GPT-native prompt support).",
  "For other GPT models, always use Hephaestus.",
].join("\n")

export const HEPHAESTUS_UNAVAILABLE_TOAST_MESSAGE = [
  "Sisyphus is running with a GPT model it has no native prompt for.",
  "Hephaestus is not available in this session (disabled, or its configured model is not a supported GPT model), so the agent was not switched.",
  "Use a Claude, Kimi, or GLM model for Sisyphus, or enable Hephaestus with a supported GPT model.",
].join("\n")

/**
 * Decide the effect for a session request. `hephaestusAvailable` is the live
 * registered-roster check. Returns `{ action, message? , reason }` where action
 * is "none" | "redirect" | "keep".
 */
export function decideNoSisyphusGpt({ agent, modelID, hephaestusAvailable } = {}) {
  if (normalizeAgentKey(agent) !== SISYPHUS_AGENT_KEY) return { action: "none", reason: "not-sisyphus" }
  if (typeof modelID !== "string" || !modelID) return { action: "none", reason: "no-model" }
  if (!isGptModel(modelID) || isGptNativeSisyphusModel(modelID) || isGpt6Model(modelID)) {
    return { action: "none", reason: "supported" }
  }
  return hephaestusAvailable
    ? { action: "redirect", message: TOAST_MESSAGE, reason: "unsupported-gpt" }
    : { action: "keep", message: HEPHAESTUS_UNAVAILABLE_TOAST_MESSAGE, reason: "hephaestus-unavailable" }
}

/**
 * Build the side-effecting enforcement bound to the V2 session/attention
 * surfaces. `hephaestusTarget` returns the REGISTERED Hephaestus name/id (or
 * undefined when it is not in the roster); `switchAgent`, `notify` and `log` are
 * injected so the behavior is testable without booting the runtime. A
 * per-session guard keeps the switch/notice to once per session; `clear`
 * drops it.
 */
export function createNativeNoSisyphusGptEnforcement({ switchAgent, notify, hephaestusTarget, resolveSession, log } = {}) {
  const handled = new Set()

  // A rejected `attention.notify` must never escape as an unhandled rejection:
  // the notice is a side effect, never a gate on the turn or on the switch.
  async function deliverNotice(payload, { sessionID, source }) {
    try {
      await notify?.(payload)
    } catch (error) {
      log?.("no-sisyphus-gpt: notify failed", { sessionID, source, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function evaluate({ sessionID, agent, modelID, source }) {
    const target = typeof hephaestusTarget === "function" ? hephaestusTarget() : undefined
    const decision = decideNoSisyphusGpt({ agent, modelID, hephaestusAvailable: Boolean(target) })
    if (decision.action === "none") return decision
    if (sessionID && handled.has(sessionID)) return { ...decision, alreadyHandled: true }

    if (decision.action === "redirect") {
      try {
        // The switch is confirmed only when it resolves. A synchronous throw and
        // an awaited rejection both land in the catch.
        await switchAgent?.({ sessionID, agent: target })
      } catch (error) {
        // The turn will still run on Sisyphus: report the truth, surface the
        // failure, and do NOT mark the session handled, so a later prompt can
        // retry the switch instead of silently continuing on GPT.
        const message = error instanceof Error ? error.message : String(error)
        await deliverNotice({ sessionID, message: decision.message, variant: "error" }, { sessionID, source })
        log?.("no-sisyphus-gpt: switchAgent failed", { sessionID, modelID, switched: false, failed: true, target: target ?? null, source, error: message })
        return { ...decision, switched: false, failed: true, error: message }
      }
      await deliverNotice({ sessionID, message: decision.message, variant: "error" }, { sessionID, source })
      log?.(`no-sisyphus-gpt: ${decision.reason}`, { sessionID, modelID, switched: true, target: target ?? null, source })
      if (sessionID) handled.add(sessionID)
      return { ...decision, switched: true }
    }

    // action "keep": Hephaestus is unavailable, so there is no switch to confirm.
    await deliverNotice({ sessionID, message: decision.message, variant: "error" }, { sessionID, source })
    log?.(`no-sisyphus-gpt: ${decision.reason}`, { sessionID, modelID, switched: false, target: target ?? null, source })
    if (sessionID) handled.add(sessionID)
    return { ...decision, switched: false }
  }
  return {
    // The `prompt` boundary runs BEFORE the turn's request is built, so switching
    // here makes the CURRENT turn use Hephaestus (agent + prompt + model), not just
    // future turns. `resolveSession` reads the live session agent/model.
    async handlePrompt(sessionID) {
      if (typeof sessionID !== "string" || !sessionID) return { action: "none" }
      if (handled.has(sessionID)) return { action: "none", alreadyHandled: true }
      if (typeof resolveSession !== "function") return { action: "none" }
      const resolved = await resolveSession(sessionID)
      if (!resolved) return { action: "none" }
      return evaluate({ sessionID, agent: resolved.agent, modelID: resolved.modelID, source: "prompt" })
    },
    async handle(event) {
      const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined
      const agent = typeof event?.agent === "string" ? event.agent : undefined
      const modelID = typeof event?.model?.modelID === "string"
        ? event.model.modelID
        : (typeof event?.model?.id === "string" ? event.model.id : undefined)
      return evaluate({ sessionID, agent, modelID, source: "context" })
    },
    clear(sessionID) {
      if (sessionID) handled.delete(sessionID)
    },
  }
}
