// OpenCode V2 adapter for the OmO legacy `{ id, server }` plugin module.
// The installer substitutes __OMO_DIST_ENTRY__ with the local built artifact.
import legacyModule from "__OMO_DIST_ENTRY__"

const fallbackClient = {
  app: { log: async () => undefined },
  session: { messages: async () => ({ data: [] }) },
}

export default {
  id: "oh-my-openagent",
  setup: async (context) => {
    const directory = context?.location?.directory ?? process.cwd()
    const client = context?.client ?? fallbackClient
    const serverUrl = context?.serverUrl ?? new URL("http://127.0.0.1:4096")
    console.error(`[ho-my-rigel] V2 adapter starting for ${directory}`)
    try {
      const hooks = await legacyModule.server({ directory, client, serverUrl, $: context?.$ }, {})
      console.error(`[ho-my-rigel] legacy hooks registered: ${Object.keys(hooks).join(",")}`)
      return hooks
    } catch (error) {
      console.error(`[ho-my-rigel] V2 adapter failed: ${error instanceof Error ? error.stack : String(error)}`)
      throw error
    }
  },
}
