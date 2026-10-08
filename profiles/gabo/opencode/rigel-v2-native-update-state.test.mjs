import { describe, expect, test } from "bun:test"
import { createNativeUpdateState } from "./rigel-v2-native-update-state.mjs"

// The state layer is the durability seam: a malformed or unreadable record must
// never throw into the non-blocking check, and a failed write must be reported
// out-of-band rather than propagated.

describe("availability", () => {
  test("#given storage with get and set #when created #then it is available", () => {
    // given
    const storage = { get: () => undefined, set: () => {} }
    // when
    const state = createNativeUpdateState({ storage })
    // then
    expect(state.available).toBe(true)
  })

  test("#given missing or partial storage #when created #then it is unavailable but safe", async () => {
    // given / when / then
    const missing = createNativeUpdateState({ storage: undefined })
    const partial = createNativeUpdateState({ storage: { get: () => 1 } })
    expect(missing.available).toBe(false)
    expect(partial.available).toBe(false)
    await expect(missing.read()).resolves.toEqual({})
    await expect(missing.write({ lastCheckedAt: 1 })).resolves.toBeUndefined()
  })
})

describe("read", () => {
  test("#given a missing record #when read #then it resolves to an empty object", async () => {
    // given
    const state = createNativeUpdateState({ storage: { get: () => undefined, set: () => {} } })
    // when
    const record = await state.read()
    // then
    expect(record).toEqual({})
  })

  test("#given a stored object #when read #then it is returned", async () => {
    // given
    const stored = { lastCheckedAt: 42, latest: "2.0.0" }
    const state = createNativeUpdateState({ storage: { get: () => stored, set: () => {} } })
    // when
    const record = await state.read()
    // then
    expect(record).toEqual(stored)
  })

  test("#given a malformed stored value #when read #then it resolves to an empty object", async () => {
    // given: a string, an array, and null are all non-objects
    // when / then
    for (const value of ["nope", [1, 2], null, 7]) {
      const state = createNativeUpdateState({ storage: { get: () => value, set: () => {} } })
      await expect(state.read()).resolves.toEqual({})
    }
  })

  test("#given a storage whose get throws #when read #then it resolves to an empty object", async () => {
    // given
    const state = createNativeUpdateState({
      storage: {
        get: () => {
          throw new Error("storage offline")
        },
        set: () => {},
      },
    })
    // when / then
    await expect(state.read()).resolves.toEqual({})
  })
})

describe("write", () => {
  test("#given a record #when written #then storage.set receives the prefixed key", async () => {
    // given
    const calls = []
    const state = createNativeUpdateState({
      storage: {
        get: () => undefined,
        set: (key, value) => calls.push({ key, value }),
      },
    })
    // when
    await state.write({ lastCheckedAt: 1234, latest: "3.0.0" })
    // then
    expect(calls).toEqual([{ key: "rigel-v2/update-check/status", value: { lastCheckedAt: 1234, latest: "3.0.0" } }])
  })

  test("#given a custom prefix and key #when written #then the storage key reflects both", async () => {
    // given
    const keys = []
    const state = createNativeUpdateState({
      prefix: "custom/root",
      key: "check",
      storage: {
        get: () => undefined,
        set: (key) => keys.push(key),
      },
    })
    // when
    await state.write({})
    // then
    expect(keys).toEqual(["custom/root/check"])
  })

  test("#given a storage whose set throws #when written #then the failure is reported and swallowed", async () => {
    // given
    const errors = []
    const state = createNativeUpdateState({
      storage: {
        get: () => undefined,
        set: () => {
          throw new Error("disk full")
        },
      },
      onError: (error) => errors.push(error),
    })
    // when / then: write resolves and the error reaches onError instead
    await expect(state.write({ lastCheckedAt: 1 })).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe("disk full")
  })

  test("#given a throwing onError reporter #when write fails #then the failure still does not propagate", async () => {
    // given
    const state = createNativeUpdateState({
      storage: {
        get: () => undefined,
        set: () => {
          throw new Error("disk full")
        },
      },
      onError: () => {
        throw new Error("reporter broke")
      },
    })
    // when / then
    await expect(state.write({ lastCheckedAt: 1 })).resolves.toBeUndefined()
  })
})
