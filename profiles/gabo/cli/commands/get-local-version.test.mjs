/**
 * Module contract for the Rigel V2 CLI `get-local-version` command: drives the
 * real `run(argv, io)` with a captured io, an injected `io.fetch` (no real
 * network) and a temp repo whose package.json pins the running version. POSITIVE
 * and NEGATIVE rows per branch.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getLocalVersionCommand } from "./get-local-version.mjs"

const created = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

function repoWithVersion(version) {
  const root = tempDir("rigel-version-repo-")
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "oh-my-openagent", version }))
  return root
}

function makeIo({ version = "5.0.0", tags, env = {}, fetch } = {}) {
  const out = []
  const err = []
  const calls = []
  const io = {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    env: { RIGEL_V2_REPO_ROOT: repoWithVersion(version), ...env },
    cwd: process.cwd(),
    spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    fetch: fetch ?? (async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => tags }
    }),
    text: () => out.join(""),
    errors: () => err.join(""),
    calls,
  }
  return io
}

describe("#given the get-local-version command", () => {
  test("#when the published version equals the running version #then it is up to date, exit 0, in text and json", async () => {
    const textIo = makeIo({ version: "5.0.0", tags: { latest: "5.0.0" } })
    expect(await getLocalVersionCommand.run([], textIo)).toBe(0)
    expect(textIo.text()).toBe("oh-my-rigel 5.0.0 (latest: 5.0.0)\n")

    const jsonIo = makeIo({ version: "5.0.0", tags: { latest: "5.0.0" } })
    expect(await getLocalVersionCommand.run(["--json"], jsonIo)).toBe(0)
    expect(JSON.parse(jsonIo.text())).toEqual({
      currentVersion: "5.0.0",
      latestVersion: "5.0.0",
      isUpToDate: true,
      channel: "latest",
      status: "up-to-date",
    })
  })

  test("#when a newer version is published #then it reports outdated with exit 0", async () => {
    const io = makeIo({ version: "5.0.0", tags: { latest: "5.0.1" } })
    expect(await getLocalVersionCommand.run(["--json"], io)).toBe(0)
    expect(JSON.parse(io.text())).toMatchObject({ isUpToDate: false, status: "outdated", latestVersion: "5.0.1" })
  })

  test("#when the running version is a prerelease #then the matching dist-tag channel is used", async () => {
    const io = makeIo({ version: "5.0.0-beta.1", tags: { latest: "4.9.0", beta: "5.0.0-beta.2" } })
    expect(await getLocalVersionCommand.run(["--json"], io)).toBe(0)
    expect(JSON.parse(io.text())).toMatchObject({ channel: "beta", latestVersion: "5.0.0-beta.2", status: "outdated" })
    expect(io.calls[0].url).toBe("https://registry.npmjs.org/-/package/oh-my-openagent/dist-tags")
    expect(io.calls[0].options.signal).toBeTruthy()
  })

  test("#when a registry is passed #then the injected URL is queried instead of the default", async () => {
    const io = makeIo({ tags: { latest: "5.0.0" } })
    await getLocalVersionCommand.run(["--registry", "https://mirror.test/rigel/dist-tags"], io)
    expect(io.calls[0].url).toBe("https://mirror.test/rigel/dist-tags")
  })

  test("#when the package name is overridden by env #then it is used in the default URL", async () => {
    const io = makeIo({ tags: { latest: "5.0.0" }, env: { RIGEL_UPDATE_PACKAGE: "custom-pkg" } })
    await getLocalVersionCommand.run([], io)
    expect(io.calls[0].url).toBe("https://registry.npmjs.org/-/package/custom-pkg/dist-tags")
  })

  test("#when the registry request fails #then it degrades to error, exit 1, and never throws", async () => {
    const io = makeIo({ version: "5.0.0", fetch: async () => { throw new Error("ECONNREFUSED") } })
    expect(await getLocalVersionCommand.run(["--json"], io)).toBe(1)
    expect(JSON.parse(io.text())).toEqual({
      currentVersion: "5.0.0",
      latestVersion: null,
      isUpToDate: false,
      channel: "latest",
      status: "error",
    })
  })

  test("#when the registry responds not ok #then it reports error, exit 1, and prints unknown as the latest", async () => {
    const io = makeIo({ version: "5.0.0", fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
    expect(await getLocalVersionCommand.run([], io)).toBe(1)
    expect(io.text()).toBe("oh-my-rigel 5.0.0 (latest: unknown)\n")
  })

  test("#when no fetch is injected #then it reports unknown with exit 1", async () => {
    const io = makeIo({ version: "5.0.0" })
    delete io.fetch
    expect(await getLocalVersionCommand.run(["--json"], io)).toBe(1)
    expect(JSON.parse(io.text())).toMatchObject({ status: "unknown", latestVersion: null, isUpToDate: false })
  })

  test("#when the published version is not parseable semver #then it reports unknown with exit 1", async () => {
    const io = makeIo({ version: "5.0.0", tags: { latest: "not-a-version" } })
    expect(await getLocalVersionCommand.run(["--json"], io)).toBe(1)
    expect(JSON.parse(io.text())).toMatchObject({ status: "unknown", latestVersion: "not-a-version", isUpToDate: false })
  })
})
