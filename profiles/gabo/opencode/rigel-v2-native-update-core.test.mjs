import { describe, expect, test } from "bun:test"
import {
  UPDATE_CHECK_TTL_MS,
  UPDATE_NOTICE_MARKER,
  compareSemverVersions,
  extractChannel,
  formatUpdateNotice,
  isStrictlyNewerVersion,
  resolveLatestForChannel,
  shouldRefresh,
} from "./rigel-v2-native-update-core.mjs"

// The comparator is the update decision's only correctness gate: a
// "different means update" bug offers a downgrade, so prerelease ordering and
// the null-on-unparseable contract are pinned here against the V1 behavior.

describe("compareSemverVersions", () => {
  test("#given equal versions #when compared #then the result is 0", () => {
    // given / when / then
    expect(compareSemverVersions("1.2.3", "1.2.3")).toBe(0)
    expect(compareSemverVersions("1.2.3+build.7", "1.2.3")).toBe(0)
  })

  test("#given an older first version #when compared #then the result is -1", () => {
    // given / when / then
    expect(compareSemverVersions("1.2.3", "1.2.4")).toBe(-1)
    expect(compareSemverVersions("1.2.3", "2.0.0")).toBe(-1)
  })

  test("#given a newer first version #when compared #then the result is 1", () => {
    // given / when / then
    expect(compareSemverVersions("1.2.4", "1.2.3")).toBe(1)
    expect(compareSemverVersions("2.0.0", "1.9.9")).toBe(1)
  })

  test("#given two prereleases #when ordered #then numeric and lexical rules match semver", () => {
    // given: betas order by their numeric identifier
    expect(compareSemverVersions("5.0.0-beta.85", "5.0.0-beta.89")).toBe(-1)
    expect(compareSemverVersions("5.0.0-beta.89", "5.0.0-beta.85")).toBe(1)
    // and a release outranks its own prerelease
    expect(compareSemverVersions("5.0.0-beta.89", "5.0.0")).toBe(-1)
    expect(compareSemverVersions("5.0.0", "5.0.0-beta.89")).toBe(1)
    // numeric identifiers sort before alphanumeric ones
    expect(compareSemverVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1)
    // a shorter prerelease set sorts lower
    expect(compareSemverVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1)
  })

  test("#given a non-semver version #when compared #then the result is null", () => {
    // given / when / then: "cannot tell" must never read as an update
    expect(compareSemverVersions("v1.2.3", "1.2.3")).toBe(null)
    expect(compareSemverVersions("1.2", "1.2.3")).toBe(null)
    expect(compareSemverVersions("", "1.0.0")).toBe(null)
    expect(compareSemverVersions(undefined, "1.0.0")).toBe(null)
  })
})

describe("isStrictlyNewerVersion", () => {
  test("#given a strictly newer latest #when checked #then it is true", () => {
    // given / when / then
    expect(isStrictlyNewerVersion("1.0.0", "1.0.1")).toBe(true)
    expect(isStrictlyNewerVersion("5.0.0-beta.85", "5.0.0-beta.89")).toBe(true)
  })

  test("#given an equal, older, or unparseable latest #when checked #then it is false", () => {
    // given / when / then
    expect(isStrictlyNewerVersion("1.0.0", "1.0.0")).toBe(false)
    expect(isStrictlyNewerVersion("1.0.1", "1.0.0")).toBe(false)
    expect(isStrictlyNewerVersion("1.0.0", "not-a-version")).toBe(false)
  })
})

describe("extractChannel", () => {
  test("#given a stable version or a missing value #when resolved #then the channel is latest", () => {
    // given / when / then
    expect(extractChannel("1.2.3")).toBe("latest")
    expect(extractChannel(null)).toBe("latest")
    expect(extractChannel(undefined)).toBe("latest")
    expect(extractChannel("")).toBe("latest")
  })

  test("#given a dist-tag #when resolved #then the tag is its own channel", () => {
    // given / when / then
    expect(extractChannel("beta")).toBe("beta")
    expect(extractChannel("next")).toBe("next")
  })

  test("#given a prerelease version #when resolved #then the known prefix is the channel", () => {
    // given / when / then
    expect(extractChannel("5.0.0-beta.85")).toBe("beta")
    expect(extractChannel("1.0.0-rc.2")).toBe("rc")
    expect(extractChannel("1.0.0-alpha.1")).toBe("alpha")
    expect(extractChannel("1.0.0-canary.3")).toBe("canary")
  })

  test("#given an unknown prerelease prefix #when resolved #then the channel falls back to latest", () => {
    // given / when / then
    expect(extractChannel("1.0.0-custom.1")).toBe("latest")
  })
})

describe("resolveLatestForChannel", () => {
  test("#given a channel string #when resolved #then that channel's version wins", () => {
    // given
    const tags = { latest: "1.0.0", beta: "2.0.0-beta.1" }
    // when / then
    expect(resolveLatestForChannel(tags, "beta")).toBe("2.0.0-beta.1")
  })

  test("#given a missing or non-string channel value #when resolved #then latest is the fallback", () => {
    // given / when / then
    expect(resolveLatestForChannel({ latest: "1.0.0" }, "beta")).toBe("1.0.0")
    expect(resolveLatestForChannel({ latest: "1.0.0", beta: 7 }, "beta")).toBe("1.0.0")
  })

  test("#given no usable tag #when resolved #then the result is undefined", () => {
    // given / when / then
    expect(resolveLatestForChannel({}, "beta")).toBe(undefined)
    expect(resolveLatestForChannel(undefined, "latest")).toBe(undefined)
  })
})

describe("shouldRefresh", () => {
  test("#given a missing, zero, or non-numeric timestamp #when checked #then it refreshes", () => {
    // given / when / then
    expect(shouldRefresh(undefined, 1000)).toBe(true)
    expect(shouldRefresh(0, 1000)).toBe(true)
    expect(shouldRefresh("1000", 1000)).toBe(true)
    expect(shouldRefresh(-5, 1000)).toBe(true)
  })

  test("#given a timestamp inside the ttl #when checked #then it does not refresh", () => {
    // given: inside the window by one millisecond
    // when / then
    expect(shouldRefresh(1000, 1000 + UPDATE_CHECK_TTL_MS - 1)).toBe(false)
  })

  test("#given a timestamp at or past the ttl boundary #when checked #then it refreshes", () => {
    // given / when / then
    expect(shouldRefresh(1000, 1000 + UPDATE_CHECK_TTL_MS)).toBe(true)
    expect(shouldRefresh(1000, 1000 + UPDATE_CHECK_TTL_MS + 1)).toBe(true)
  })

  test("#given a future timestamp #when checked #then it refreshes as stale", () => {
    // given / when / then
    expect(shouldRefresh(2000, 1000)).toBe(true)
  })
})

describe("formatUpdateNotice", () => {
  test("#given versions #when formatted #then the notice starts with the marker and names both sides", () => {
    // given
    const notice = formatUpdateNotice({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      packageName: "oh-my-openagent",
    })
    // when / then
    expect(notice.startsWith(UPDATE_NOTICE_MARKER)).toBe(true)
    expect(notice).toContain("2.0.0")
    expect(notice).toContain("1.0.0")
    expect(notice).toContain("automatic")
  })
})
