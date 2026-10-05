function toolInput(event) {
  return event?.input && typeof event.input === "object" && !Array.isArray(event.input) ? event.input : undefined
}

function pureSleep(command) {
  return typeof command === "string" && command.trim().split(/\r?\n/).every((line) => /^sleep\s+\d+(?:\.\d+)?$/.test(line.trim()))
}

export function createNativeToolBeforeRules({ backgroundManager } = {}) {
  return Object.freeze([
    {
      name: "mcp-prefix-strip",
      run(event) {
        if (typeof event?.tool === "string" && event.tool.startsWith("mcp_")) event.tool = event.tool.slice(4)
      },
    },
    {
      name: "bash-null-byte-strip",
      run(event) {
        const input = toolInput(event)
        if ((event?.tool === "bash" || event?.tool === "interactive_bash") && typeof input?.command === "string") {
          input.command = input.command.replaceAll("\0", "")
        }
      },
    },
    {
      name: "background-sleep-block",
      run(event) {
        const input = toolInput(event)
        if ((event?.tool === "bash" || event?.tool === "interactive_bash")
          && pureSleep(input?.command)
          && (backgroundManager?.activeCount?.(event?.sessionID) ?? 0) > 0) {
          throw new Error("Background task wait is already managed by the plugin. End this response and wait for the completion notification.")
        }
      },
    },
  ])
}
