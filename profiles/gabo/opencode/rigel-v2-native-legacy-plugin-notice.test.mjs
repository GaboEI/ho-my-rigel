import { describe, expect, test } from "bun:test"
import {
  detectLegacyPluginEntry,
  LEGACY_NOTICE_MESSAGE,
  pluginEntryName,
} from "./rigel-v2-native-legacy-plugin-notice.mjs"

describe("the legacy detector matches the V1 rename contract", () => {
  test("#given a bare legacy entry #when detected #then it is reported", () => {
    // given
    const config = { plugin: ["oh-my-opencode"] }

    // when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.legacy).toBe(true)
    expect(result.entries).toEqual(["oh-my-opencode"])
  })

  test("#given a versioned legacy entry #when detected #then it is reported", () => {
    // given
    const config = { plugin: ["oh-my-opencode@3.2.1"] }

    // when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.legacy).toBe(true)
    expect(result.entries).toEqual(["oh-my-opencode@3.2.1"])
  })

  test("#given a tuple legacy entry #when detected #then its name is reported", () => {
    // given
    const config = { plugin: [["oh-my-opencode", { enabled: true }]] }

    // when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.legacy).toBe(true)
    expect(result.entries).toEqual(["oh-my-opencode"])
  })

  test("#given several legacy entries #when detected #then every name is reported in order", () => {
    // given
    const config = { plugin: ["other-plugin", "oh-my-opencode", "oh-my-opencode@1.0.0"] }

    // when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.entries).toEqual(["oh-my-opencode", "oh-my-opencode@1.0.0"])
  })
})

describe("the legacy detector leaves canonical and unrelated entries alone", () => {
  test("#given only canonical entries #when detected #then nothing is reported", () => {
    // given
    const config = { plugin: ["oh-my-openagent", "oh-my-openagent@2.0.0"] }

    // when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.legacy).toBe(false)
    expect(result.entries).toEqual([])
  })

  test("#given an unrelated package whose name merely contains the legacy name #when detected #then it is not reported", () => {
    // given
    const config = { plugin: ["oh-my-opencode-extra", "not-oh-my-opencode@1.0.0"] }

    // when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.legacy).toBe(false)
    expect(result.entries).toEqual([])
  })

  test("#given a canonical entry beside a legacy one #when detected #then only the legacy name is reported", () => {
    // given
    const config = { plugin: ["oh-my-openagent", "oh-my-opencode"] }

    // when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.entries).toEqual(["oh-my-opencode"])
  })
})

describe("the legacy detector never throws on a shapeshifted config", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "oh-my-opencode"],
    ["an array", ["oh-my-opencode"]],
    ["no plugin key", {}],
    ["a non-array plugin", { plugin: "oh-my-opencode" }],
    ["a mixed array", { plugin: [42, null, "oh-my-openagent"] }],
  ])("#given %s #when detected #then it reports nothing rather than throwing", (_label, config) => {
    // given / when
    const result = detectLegacyPluginEntry(config)

    // then
    expect(result.legacy).toBe(false)
    expect(result.entries).toEqual([])
  })
})

describe("entry name resolution mirrors the V1 tuple shape", () => {
  test("#given a tuple #when read #then the first element is the name", () => {
    // given / when / then
    expect(pluginEntryName(["oh-my-openagent", { x: 1 }])).toBe("oh-my-openagent")
  })

  test("#given a bare string #when read #then the string is the name", () => {
    // given / when / then
    expect(pluginEntryName("oh-my-openagent")).toBe("oh-my-openagent")
  })

  test("#given a malformed entry #when read #then an empty name is returned", () => {
    // given / when / then
    expect(pluginEntryName([42])).toBe("")
    expect(pluginEntryName(null)).toBe("")
  })
})

describe("the notice text is the exact rename instruction", () => {
  test("#given the notice message #when read #then it names both identities and the install command", () => {
    // given / when / then
    expect(LEGACY_NOTICE_MESSAGE).toBe(
      'Update your opencode.json: "oh-my-opencode" has been renamed to "oh-my-openagent".\nRun: bunx oh-my-openagent install',
    )
  })
})
