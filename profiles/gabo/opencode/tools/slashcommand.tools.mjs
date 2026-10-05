// Native OpenCode V2 `slashcommand` tool (Phase-4 Ola 6; V1 parity:
// `tools/slashcommand/command-discovery.ts`). V1 discovered commands by
// walking project directories; V2 owns the command catalog, so the native tool
// reads the host's merged command list (`ctx.command.list()`) and renders the
// same "which /commands exist" surface for the model. Registered only when the
// host exposes the command domain: a host without it has nothing to list.

const SLASHCOMMAND_TOOL_NAME = "slashcommand"
const SLASHCOMMAND_DESCRIPTION = "List the slash commands available in the host with their descriptions. Use when you need to discover which /commands exist before invoking one."

function extractCommandEntries(response) {
  const source = Array.isArray(response)
    ? response
    : Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.commands)
        ? response.commands
        : []
  return source.filter((entry) => entry && typeof entry === "object" && typeof entry.name === "string" && entry.name.trim())
}

export function formatCommandCatalog(entries) {
  if (entries.length === 0) return "No slash commands are registered in the host."
  return entries
    .map((entry) => `- /${entry.name.replace(/^\//, "")}${typeof entry.description === "string" && entry.description.trim() ? `: ${entry.description.trim()}` : ""}`)
    .join("\n")
}

export function createSlashcommandTool({ listCommands } = {}) {
  if (typeof listCommands !== "function") throw new Error("A host command list function is required for the slashcommand tool")
  return {
    name: SLASHCOMMAND_TOOL_NAME,
    options: { codemode: false },
    description: SLASHCOMMAND_DESCRIPTION,
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const response = await listCommands()
      const entries = extractCommandEntries(response)
      return { content: formatCommandCatalog(entries) }
    },
  }
}
