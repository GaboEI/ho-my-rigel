// OpenCode V2 entrypoint for the OmO legacy `{ id, server }` plugin module.
// The installer substitutes __OMO_DIST_ENTRY__ with the local built artifact.
import legacyModule from "__OMO_DIST_ENTRY__"
import { createRigelV2Plugin } from "./omo-v2-adapter-core.mjs"

export default createRigelV2Plugin({
  id: "ho-my-rigel",
  loadLegacyHooks: async ({ directory, client, serverUrl, $ }) => legacyModule.server({ directory, client, serverUrl, $ }, {}),
})
