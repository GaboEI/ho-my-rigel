// Native OpenCode V2 runtime for the remaining V1 builtin commands
// (`features/builtin-commands/`). V1 registered each command as an
// `<command-instruction>` template the model then acts on; the native surface
// registers the same commands through `ctx.command.transform` and delivers the
// rendered V1 template into the real session turn via `ctx.session.prompt`,
// which is the official V2 command-executor contract.
//
// The template bodies are not hand-copied: they are generated from the V1 owner
// into `rigel-v2-native-builtin-command-manifest.mjs` (see
// `generate-v2-builtin-command-manifest.mjs`) so the deployed runtime cannot
// drift from `commands.ts`.
import builtinCommandManifest from "./rigel-v2-native-builtin-command-manifest.mjs"
import { renderCommandTemplate } from "./rigel-v2-auto-slash-command-executor.mjs"

/** The V1 builtin commands this module owns, in V1 declaration order. */
export const BUILTIN_COMMAND_NAMES = Object.freeze(Object.keys(builtinCommandManifest.commands))

/**
 * Render one command template the way V1/OpenCode expanded commands:
 * `$ARGUMENTS` (and `${ARGUMENTS}` / `$1..$9`) from the invocation text, then
 * the `$SESSION_ID` and `$TIMESTAMP` placeholders. The V1 `handoff` body uses
 * `$SESSION_ID` inside `session_read(...)` calls, so those must resolve too, not
 * only the copy inside the `<session-context>` wrapper.
 */
export function renderBuiltinCommandTemplate(template, { args = "", sessionID = "", timestamp = "" } = {}) {
  return renderCommandTemplate(String(template ?? ""), args)
    .replace(/\$SESSION_ID/g, String(sessionID))
    .replace(/\$TIMESTAMP/g, String(timestamp))
}

/**
 * Build the V2 command definitions for the manifest. A definition is dropped
 * when its name is listed in `disabled_commands` (V1 parity) or when the
 * manifest carries no base template. The team-mode variant is selected from the
 * materialized `team_mode` gate, mirroring V1's addendum on `refactor` and
 * `remove-ai-slops`.
 */
export function createBuiltinCommandDefinitions({
  context,
  manifest = builtinCommandManifest,
  teamModeEnabled = false,
  disabledCommands = [],
  now = () => new Date(),
} = {}) {
  const disabled = new Set(Array.isArray(disabledCommands) ? disabledCommands : [])
  const definitions = []
  for (const [name, entry] of Object.entries(manifest?.commands ?? {})) {
    if (disabled.has(name)) continue
    const template = teamModeEnabled && typeof entry?.teamModeTemplate === "string" ? entry.teamModeTemplate : entry?.template
    if (typeof template !== "string") continue
    definitions.push({
      name,
      description: typeof entry.description === "string" ? entry.description : "",
      execute: async (invocation = {}) => {
        const { sessionID, prompt, delivery } = invocation
        if (typeof sessionID !== "string" || sessionID.length === 0) return
        const base = prompt !== null && typeof prompt === "object" ? prompt : {}
        const args = typeof prompt === "string" ? prompt : typeof prompt?.text === "string" ? prompt.text : ""
        const text = renderBuiltinCommandTemplate(template, { args, sessionID, timestamp: now().toISOString() })
        await context.session.prompt({ ...base, sessionID, text, delivery })
      },
    })
  }
  return definitions
}

/**
 * Register the native builtin commands. Returns the host registration (with
 * `dispose`) or `undefined` when the host exposes no command domain or every
 * command is disabled, so the caller can dispose uniformly.
 */
export async function registerBuiltinCommands(options = {}) {
  const { context } = options
  if (typeof context?.command?.transform !== "function") return undefined
  const definitions = createBuiltinCommandDefinitions(options)
  if (definitions.length === 0) return undefined
  return context.command.transform((editor) => {
    for (const definition of definitions) editor.add(definition)
  })
}
