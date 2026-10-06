import { expect, test } from "bun:test"

import plugin from "./rigel-v2-native.mjs"

// The V2 host requires every tool `execute` to return a result OBJECT. Native
// tools ported from V1 return a raw string (session and monitor families). The
// runtime normalizes them at the registration seam; this contract fails if a
// family tool is registered without that seam (a string return crashes the host
// with `"output" in s` on a primitive, observed live in the lab).
function createSetupContext(added) {
  return {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_native" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: {
      transform: async (callback) => {
        callback({
          add: (value) => { if (value?.name) added.set(value.name, value) },
          get: () => undefined,
        })
        return { dispose() {} }
      },
    },
  }
}

test("native runtime registers every family tool with a V2 result-object normalizer", async () => {
  // given
  const added = new Map()
  const dispose = await plugin.setup(createSetupContext(added))
  const sessionList = added.get("session_list")
  const lookAt = added.get("look_at")

  // when: a family tool that returns a V1-style string executes with no server
  const result = await sessionList.execute({}, {})

  // then
  expect(typeof result).toBe("object")
  expect(typeof result.content).toBe("string")
  // an object-returning family tool is left valid
  expect(typeof lookAt.execute).toBe("function")
  await dispose()
})
