import { describe, expect, test } from "bun:test"
import { createNativeUpdateChecker } from "./rigel-v2-native-update-checker.mjs"
import { UPDATE_NOTICE_MARKER } from "./rigel-v2-native-update-core.mjs"

// The checker owns the whole effect: one attempt per process, a per-day cache,
// a notice only for a strictly newer version, and silence (plus a receipt) on
// every failure. All network and storage is injected so these run on the real
// decision path with no real I/O.

function createRecordingState(initial = {}) {
  const writes = []
  let record = initial
  return {
    available: true,
    writes,
    async read() {
      return record
    },
    async write(next) {
      writes.push(next)
      record = next
    },
  }
}

function okResponse(body) {
  return { ok: true, status: 200, async json() { return body } }
}

function createFetchSpy(response) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (typeof response === "function") return response()
    if (response instanceof Error) throw response
    return response
  }
  return { fetchImpl, calls }
}

describe("successful checks", () => {
  test("#given a strictly newer registry version #when refreshed #then a notice is produced and cached", async () => {
    // given
    const receipts = []
    const state = createRecordingState({})
    const { fetchImpl, calls } = createFetchSpy(okResponse({ latest: "2.0.0" }))
    const checker = createNativeUpdateChecker({
      state,
      fetchImpl,
      registryUrl: "https://registry.test/pkg",
      packageName: "oh-my-openagent",
      currentVersion: "1.0.0",
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://registry.test/pkg")
    expect(calls[0].options.headers.accept).toBe("application/json")
    expect(checker.getNotice().startsWith(UPDATE_NOTICE_MARKER)).toBe(true)
    expect(checker.getNotice()).toContain("2.0.0")
    expect(checker.getNotice()).toContain("1.0.0")
    expect(receipts).toEqual([{ outcome: "updateAvailable", currentVersion: "1.0.0", latestVersion: "2.0.0" }])
    // the attempt was recorded before the fetch, then the resolved latest
    expect(state.writes).toEqual([{ lastCheckedAt: 1000 }, { lastCheckedAt: 1000, latest: "2.0.0" }])
  })

  test("#given an equal registry version #when refreshed #then no notice is produced", async () => {
    // given
    const receipts = []
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: createFetchSpy(okResponse({ latest: "1.0.0" })).fetchImpl,
      registryUrl: "https://registry.test/pkg",
      packageName: "oh-my-openagent",
      currentVersion: "1.0.0",
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(checker.getNotice()).toBe("")
    expect(receipts).toEqual([{ outcome: "upToDate", currentVersion: "1.0.0", latestVersion: "1.0.0" }])
  })

  test("#given an older registry version #when refreshed #then no notice is produced", async () => {
    // given
    const receipts = []
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: createFetchSpy(okResponse({ latest: "0.9.0" })).fetchImpl,
      registryUrl: "https://registry.test/pkg",
      packageName: "oh-my-openagent",
      currentVersion: "1.0.0",
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(checker.getNotice()).toBe("")
    expect(receipts[0].outcome).toBe("upToDate")
  })

  test("#given a prerelease current version #when refreshed #then its channel tag is used", async () => {
    // given
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: createFetchSpy(okResponse({ latest: "1.0.0", beta: "2.0.0-beta.2" })).fetchImpl,
      registryUrl: "https://registry.test/pkg",
      packageName: "oh-my-openagent",
      currentVersion: "1.0.0-beta.1",
      now: () => 1000,
    })

    // when
    await checker.refresh()

    // then: the beta tag won, not latest
    expect(checker.getNotice()).toContain("2.0.0-beta.2")
  })
})

describe("failure degradation", () => {
  test("#given a fetch that rejects #when refreshed #then it does not throw and reports failure", async () => {
    // given
    const receipts = []
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: createFetchSpy(new Error("network down")).fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when / then
    await expect(checker.refresh()).resolves.toBeUndefined()
    expect(checker.getNotice()).toBe("")
    expect(receipts).toEqual([{ outcome: "failed", error: "network down" }])
  })

  test("#given a non-ok response #when refreshed #then it reports failure", async () => {
    // given
    const receipts = []
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: createFetchSpy({ ok: false, status: 503, async json() { return {} } }).fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(receipts[0].outcome).toBe("failed")
    expect(receipts[0].error).toContain("503")
  })

  test("#given a body that cannot be parsed #when refreshed #then it reports failure", async () => {
    // given
    const receipts = []
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: createFetchSpy({
        ok: true,
        status: 200,
        async json() {
          throw new Error("bad json")
        },
      }).fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(receipts[0].outcome).toBe("failed")
    expect(receipts[0].error).toBe("bad json")
  })

  test("#given a registry body with no usable version #when refreshed #then it reports failure", async () => {
    // given
    const receipts = []
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: createFetchSpy(okResponse({ latest: 123 })).fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(receipts[0].outcome).toBe("failed")
    expect(receipts[0].error).toBe("registry response carried no version")
  })
})

describe("caching and single-attempt semantics", () => {
  test("#given a fresh cache record #when refreshed #then no fetch happens and the outage is not retried", async () => {
    // given
    const receipts = []
    const { fetchImpl, calls } = createFetchSpy(okResponse({ latest: "2.0.0" }))
    const checker = createNativeUpdateChecker({
      state: createRecordingState({ lastCheckedAt: 1000, latest: "1.0.0" }),
      fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000 + 10,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(calls).toHaveLength(0)
    expect(receipts).toEqual([{ outcome: "cached" }])
    expect(checker.getNotice()).toBe("")
  })

  test("#given a cached record with a newer latest #when refreshed #then the notice still derives from the cache", async () => {
    // given
    const { fetchImpl, calls } = createFetchSpy(okResponse({ latest: "9.9.9" }))
    const checker = createNativeUpdateChecker({
      state: createRecordingState({ lastCheckedAt: 1000, latest: "2.0.0" }),
      fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000 + 10,
    })

    // when
    await checker.refresh()

    // then: the day's check is not repeated, yet the cached newer version still announces itself
    expect(calls).toHaveLength(0)
    expect(checker.getNotice()).toContain("2.0.0")
  })

  test("#given a stale cache record #when refreshed #then the registry is fetched", async () => {
    // given
    const { fetchImpl, calls } = createFetchSpy(okResponse({ latest: "2.0.0" }))
    const checker = createNativeUpdateChecker({
      state: createRecordingState({ lastCheckedAt: 1000, latest: "1.0.0" }),
      fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000 + 86400000,
    })

    // when
    await checker.refresh()

    // then
    expect(calls).toHaveLength(1)
    expect(checker.getNotice()).toContain("2.0.0")
  })

  test("#given two refresh calls #when both run #then the registry is fetched exactly once", async () => {
    // given
    const { fetchImpl, calls } = createFetchSpy(okResponse({ latest: "2.0.0" }))
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000,
    })

    // when
    await checker.refresh()
    await checker.refresh()

    // then
    expect(calls).toHaveLength(1)
  })

  test("#given no storage at all #when refreshed #then it still checks once and can set the notice", async () => {
    // given
    const { fetchImpl, calls } = createFetchSpy(okResponse({ latest: "2.0.0" }))
    const checker = createNativeUpdateChecker({
      state: undefined,
      fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      now: () => 1000,
    })

    // when
    await checker.refresh()

    // then
    expect(calls).toHaveLength(1)
    expect(checker.getNotice()).toContain("2.0.0")
  })
})

describe("skipped checks", () => {
  test("#given no current version #when refreshed #then no fetch happens and the outcome is skipped", async () => {
    // given
    const receipts = []
    const { fetchImpl, calls } = createFetchSpy(okResponse({ latest: "2.0.0" }))
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl,
      registryUrl: "https://registry.test/pkg",
      currentVersion: undefined,
      now: () => 1000,
      onReceipt: (event) => receipts.push(event),
    })

    // when
    await checker.refresh()

    // then
    expect(calls).toHaveLength(0)
    expect(receipts).toEqual([{ outcome: "skipped" }])
    expect(checker.getNotice()).toBe("")
  })

  test("#given no fetch implementation #when refreshed #then it skips without throwing", async () => {
    // given
    const receipts = []
    const checker = createNativeUpdateChecker({
      state: createRecordingState({}),
      fetchImpl: undefined,
      registryUrl: "https://registry.test/pkg",
      currentVersion: "1.0.0",
      onReceipt: (event) => receipts.push(event),
    })

    // when / then
    await expect(checker.refresh()).resolves.toBeUndefined()
    expect(receipts).toEqual([{ outcome: "skipped" }])
  })
})
