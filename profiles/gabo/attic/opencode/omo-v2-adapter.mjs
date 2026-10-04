// OpenCode V2 entrypoint for the OmO legacy `{ id, server }` plugin module.
// The installer substitutes __OMO_DIST_ENTRY__ with the local built artifact.
import legacyModule from "__OMO_DIST_ENTRY__"
import { createRigelV2Plugin } from "./omo-v2-adapter-core.mjs"

// This adapter is copied into an OpenCode plugin directory, where a bare
// package import cannot see the checkout dependencies. Resolve the exact tool
// factory beside the OmO bundle instead; it owns the Zod extensions present in
// the legacy definitions.
const { tool } = await import(new URL("../node_modules/@opencode-ai/plugin/dist/index.js", "__OMO_DIST_ENTRY__"))

export default createRigelV2Plugin({
  id: "oh-my-rigel",
  loadLegacyHooks: async ({ directory, client, serverUrl, $ }) => legacyModule.server({ directory, client, serverUrl, $ }, {}),
  // The V1 tool factory owns the schemas. Its JSON-Schema helper produces a
  // root document; passing individual raw fields would silently degrade in V2.
  serializeLegacyArgs: (args) => tool.schema.toJSONSchema(tool.schema.object(args)),
})
