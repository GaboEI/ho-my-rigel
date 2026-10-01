import { describe, expect, test } from "bun:test"
import { childTaskPrompt, createNativePromptHook } from "./rigel-v2-native-prompt.mjs"

describe("Rigel native OpenCode V2 prompt orchestration", () => {
  test("injects the default ultrawork directive once for a root session", async () => {
    const hook = createNativePromptHook({ ultraworkDirective: "DIRECTIVE" })
    const input = { sessionID: "ses_root", prompt: { text: "Inspect this repository." } }
    await hook(input)
    expect(input.prompt.text).toContain("<rigel-native-ultrawork>\nDIRECTIVE")
    const first = input.prompt.text
    await hook(input)
    expect(input.prompt.text).toBe(first)
  })

  test("strips the internal child marker without applying root orchestration", async () => {
    const hook = createNativePromptHook({ ultraworkDirective: "DIRECTIVE" })
    const input = { sessionID: "ses_child", prompt: { text: childTaskPrompt("List root files.") } }
    await hook(input)
    expect(input.prompt.text).toBe("List root files.")
    expect(input.prompt.text).not.toContain("DIRECTIVE")
  })

  test("keeps explicit ultrawork available when default mode is disabled", async () => {
    const hook = createNativePromptHook({ ultraworkDirective: "DIRECTIVE", defaultUltrawork: false })
    const ordinary = { sessionID: "ses_a", prompt: { text: "Explain this." } }
    const explicit = { sessionID: "ses_b", prompt: { text: "ulw: inspect this." } }
    await hook(ordinary)
    await hook(explicit)
    expect(ordinary.prompt.text).toBe("Explain this.")
    expect(explicit.prompt.text).toContain("DIRECTIVE")
  })
})
