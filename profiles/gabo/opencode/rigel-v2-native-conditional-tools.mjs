/**
 * Conditional native V2 tool families: `interactive_bash`, the `task_*` system,
 * and the goal tools.
 *
 * Gates are read from the materialized agent manifest (`metadata.global.gates`)
 * that the pending config adapter materializes. This module consumes that plain
 * object and never parses `omo.jsonc`, so the config adapter is the single owner
 * of config parsing. A gate that is absent or false means the family is NOT
 * registered: a disabled tool can never be silently exposed.
 *
 * V2 primitives used:
 * - `ctx.pty`     -> interactive_bash command runner (never shell.exec)
 * - `ctx.storage` -> task and goal persistence (never a fake in-memory store)
 * - `ctx.tool.transform` -> real tool registration
 * - `ctx.event.subscribe` + `ctx.session.prompt` -> goal idle continuation
 */

import {
  createInteractiveBashTool,
  createPtyCommandRunner,
  detectTmuxAvailability,
  INTERACTIVE_BASH_TOOL_NAME,
} from "./tools/interactive-bash.tools.mjs"
import {
  createTaskLock,
  createTaskTools,
  createV2TaskStore,
  resolveTaskListId,
  TASK_TOOL_NAMES,
} from "./tools/task.tools.mjs"
import {
  createGoalContinuation,
  createGoalController,
  createGoalTools,
  createV2GoalStore,
  GOAL_TOOL_NAMES,
} from "./tools/goal.tools.mjs"

export const NATIVE_GATE_KEYS = ["interactive_bash", "task_system", "goal", "monitor"]

/**
 * CONFIG ADAPTER SEAM (Fase 3 F1).
 *
 * The pending `rigel-v2-native-config.mjs` owns JSONC parsing and materializes
 * the resolved gates into `manifest.metadata.global.gates` via
 * `generate-v2-agents.mjs`. Its exported `readNativeGates(manifest)` reads this
 * exact plain-object shape with defaults false. This reader mirrors those
 * semantics so the tool families are usable before F1 lands; when F1 lands the
 * imported reader replaces this call site without changing any behavior here.
 */
export function readMaterializedGates(manifest) {
  const raw = manifest?.metadata?.global?.gates
  const source = raw && typeof raw === "object" ? raw : {}
  const gates = {}
  for (const key of NATIVE_GATE_KEYS) gates[key] = source[key] === true
  return gates
}

function emptyResult() {
  return { definitions: {}, names: [] }
}

/**
 * Build the enabled tool definitions for the resolved gates.
 *
 * `interactive_bash` is additionally gated on a real tmux executable; an enabled
 * gate with no tmux is therefore unavailable, not broken. Each family is only
 * built when its `ctx` domain is present; a missing domain is reported loudly
 * and the family is skipped rather than registered with a fake backend.
 */
export function buildConditionalToolDefinitions({
  gates = {},
  tmuxPath,
  ptyRunner,
  taskStore,
  taskLock,
  goalStore,
  syncTodos,
  getSessionID,
  onUnavailable = () => {},
} = {}) {
  const definitions = {}
  const names = []

  if (gates.interactive_bash === true) {
    if (typeof tmuxPath !== "string" || !tmuxPath) {
      onUnavailable("interactive_bash", "tmux is not available on PATH")
    } else if (!ptyRunner) {
      onUnavailable("interactive_bash", "V2 pty runner is unavailable")
    } else {
      definitions[INTERACTIVE_BASH_TOOL_NAME] = createInteractiveBashTool({ runner: ptyRunner, tmuxPath })
      names.push(INTERACTIVE_BASH_TOOL_NAME)
    }
  }

  if (gates.task_system === true) {
    if (taskStore) {
      const tools = createTaskTools({ store: taskStore, lock: taskLock, syncTodos, getSessionID })
      for (const name of TASK_TOOL_NAMES) {
        definitions[name] = tools[name]
        names.push(name)
      }
    } else {
      onUnavailable("task_system", "V2 storage domain is unavailable")
    }
  }

  if (gates.goal === true) {
    if (goalStore) {
      const controller = createGoalController({ store: goalStore })
      const tools = createGoalTools({ controller, getSessionID })
      for (const name of GOAL_TOOL_NAMES) {
        definitions[name] = tools[name]
        names.push(name)
      }
    } else {
      onUnavailable("goal", "V2 storage domain is unavailable")
    }
  }

  return { definitions, names }
}

function locationOf(context) {
  return context?.location ?? (context?.directory ? { directory: context.directory } : undefined)
}

/**
 * Register every enabled conditional family on the live V2 host and return a
 * disposer. Registration is additive: one `tool.transform` for the enabled
 * definitions plus one event subscription for the goal continuation.
 *
 * `gates` is the exact injection point for the config adapter. When omitted it
 * is read from the manifest; when supplied (for example by an owner test) it
 * overrides the manifest as the resolved gate set.
 */
export async function registerConditionalNativeTools({
  context,
  manifest,
  gates,
  directory,
  tmuxPath,
  ptyRunner,
  taskStore,
  taskLock,
  goalStore,
  syncTodos,
  getSessionID,
  log = console.error,
} = {}) {
  const manifestGates = readMaterializedGates(manifest)
  const resolved = { ...manifestGates, ...(gates ?? {}) }
  // interactive_bash availability comes from the host, not a config key: an
  // enabled family with no tmux must stay absent, never register a broken tool.
  // The PATH probe only runs when the family is actually requested.
  const resolvedTmuxPath = tmuxPath ?? (resolved.interactive_bash === true ? detectTmuxAvailability() : undefined)
  if (resolved.interactive_bash === true && !resolvedTmuxPath) {
    log("[ho-my-rigel] Native V2 interactive_bash requested but tmux is not available on PATH; family stays unregistered")
  }

  const unavailable = []
  const onUnavailable = (family, reason) => {
    unavailable.push({ family, reason })
    log(`[ho-my-rigel] Native V2 ${family} gate is enabled but ${reason}; family stays unregistered`)
  }

  const pty = context?.pty
  const location = locationOf(context)
  const serverUrl = context?.serverUrl
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl?.toString?.()
  const runner = ptyRunner ?? (pty && typeof pty.create === "function"
    ? createPtyCommandRunner({ pty, location, baseUrl })
    : undefined)
  const storage = context?.storage
  const listId = resolveTaskListId({ config: {} })
  const store = taskStore ?? (storage && typeof storage.get === "function"
    ? createV2TaskStore({ storage, listId })
    : undefined)
  const resolvedGoalStore = goalStore ?? (storage && typeof storage.get === "function"
    ? createV2GoalStore({ storage })
    : undefined)

  const { definitions, names } = buildConditionalToolDefinitions({
    gates: resolved,
    tmuxPath: resolvedTmuxPath,
    ptyRunner: runner,
    taskStore: store,
    taskLock: taskLock ?? createTaskLock(),
    goalStore: resolvedGoalStore,
    syncTodos,
    getSessionID,
    onUnavailable,
  })

  let registration
  if (names.length > 0 && typeof context?.tool?.transform === "function") {
    registration = await context.tool.transform((editor) => {
      for (const name of names) editor.add(definitions[name])
    })
  }

  let eventSubscription
  const disposers = []
  if (resolved.goal === true && definitions.create_goal && resolvedGoalStore) {
    const controller = createGoalController({ store: resolvedGoalStore })
    const dispatch = async ({ sessionID, text }) => {
      if (typeof context?.session?.prompt !== "function") return
      await context.session.prompt({ sessionID, text, delivery: "queue" })
    }
    const continuation = createGoalContinuation({ controller, dispatch })
    const abort = new AbortController()
    if (typeof context?.event?.subscribe === "function") {
      eventSubscription = (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: abort.signal })) {
            await continuation.handleEvent(event)
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            log(`[ho-my-rigel] Native V2 goal continuation subscription failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })()
      disposers.push(() => abort.abort())
    }
  }

  log(`[ho-my-rigel] Native V2 conditional tools: gates=${JSON.stringify(resolved)}; registered=${names.join(",") || "none"}; tmux=${resolvedTmuxPath ?? "none"}${unavailable.length ? `; unavailable=${unavailable.map((entry) => entry.family).join(",")}` : ""}`)

  return {
    gates: resolved,
    registered: names,
    definitions,
    unavailable,
    async dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already disposed */ }
      }
      await registration?.dispose?.()
      await eventSubscription
    },
  }
}
