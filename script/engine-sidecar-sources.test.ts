import { describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { RELEASE_BINARY_TARGETS, resolveExpectedSidecarRelPaths } from "./build-omo-binary"
import { codemodeRuntimeDependencySources, engineSidecarSources } from "./engine-sidecar-sources"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
// Node resolves a symlinked package from its real path, so the engine's view starts there.
const installedSenpiRequire = createRequire(
  join(realpathSync(join(repoRoot, "node_modules", "@code-yeongyu", "senpi")), "package.json"),
)

// Independent of the production resolver: the installed engine either resolves the
// package's manifest or Node reports it missing.
function engineResolves(packageName: string): boolean {
  try {
    installedSenpiRequire.resolve(`${packageName}/package.json`)
    return true
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "MODULE_NOT_FOUND") return false
    throw error
  }
}

function writePackage(
  packageDir: string,
  manifest: {
    readonly name: string
    readonly version: string
    readonly dependencies?: Readonly<Record<string, string>>
  },
): void {
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest)}\n`)
}

describe("sidecar parity set", () => {
  test("#given the css-tree trio #when the engine sidecars are resolved #then each is embedded exactly when the installed engine resolves it", () => {
    // given - the jsdom-era engine ships all three, a linkedom-era engine (senpi#1666) none
    const trio = ["css-tree", "mdn-data", "source-map-js"]

    const target = RELEASE_BINARY_TARGETS.find((entry) => entry.target === "darwin-arm64")
    if (target === undefined) throw new Error("darwin-arm64 is not a release target")

    // when
    const sources = engineSidecarSources()
    const relPaths = resolveExpectedSidecarRelPaths(target)

    // then
    for (const packageName of trio) {
      const installed = engineResolves(packageName)
      expect(sources.some((source) => source.to === `node_modules/${packageName}`)).toBe(installed)
      expect(relPaths.includes(`node_modules/${packageName}/package.json`)).toBe(installed)
    }
  })

  test("#given codemode's manifest #when runtime dependencies are resolved #then only dependencies absent from the engine host are nested transitively", () => {
    // given
    const codemode = installedSenpiRequire.resolve("@code-yeongyu/senpi-codemode/package.json")

    // when
    const destinations = codemodeRuntimeDependencySources(dirname(codemode))
      .map((source) => source.to)

    // then
    const parser = "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser"
    const types = `${parser}/node_modules/@babel/types`
    expect(destinations).toContain(parser)
    expect(destinations).toContain(types)
    expect(destinations).toContain(`${types}/node_modules/@babel/helper-string-parser`)
    expect(destinations).toContain(`${types}/node_modules/@babel/helper-validator-identifier`)
    expect(destinations.some((path) => path.includes("@earendil-works/pi-ai"))).toBe(false)
    expect(destinations.some((path) => path.endsWith("/typebox"))).toBe(false)
  })

  test("#given the host declares the same dependency name at a different version #when codemode dependencies are resolved #then codemode's version remains staged", () => {
    // given
    const root = join(tmpdir(), `omo-codemode-conflict-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { shared: "2.0.0" } })
      writePackage(join(codemode, "node_modules", "shared"), { name: "shared", version: "2.0.0" })
      writePackage(host, { name: "host", version: "1.0.0", dependencies: { shared: "1.0.0" } })
      writePackage(join(host, "node_modules", "shared"), { name: "shared", version: "1.0.0" })

      // when
      const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

      // then
      expect(destinations).toEqual([
        "node_modules/@code-yeongyu/senpi-codemode/node_modules/shared",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given the host declares but cannot resolve codemode's dependency #when resolved #then codemode's installed copy remains staged", () => {
    // given
    const root = join(tmpdir(), `omo-codemode-missing-host-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { shared: "2.0.0" } })
      writePackage(join(codemode, "node_modules", "shared"), { name: "shared", version: "2.0.0" })
      writePackage(host, { name: "host", version: "1.0.0", dependencies: { shared: "2.0.0" } })

      // when
      const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

      // then
      expect(destinations).toEqual([
        "node_modules/@code-yeongyu/senpi-codemode/node_modules/shared",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given matching aliased host and codemode dependencies #when resolved #then the host copy is reused by package identity", () => {
    // given
    const root = join(tmpdir(), `omo-codemode-alias-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { alias: "npm:actual@1.0.0" } })
      writePackage(join(codemode, "node_modules", "alias"), { name: "actual", version: "1.0.0" })
      writePackage(host, { name: "host", version: "1.0.0", dependencies: { alias: "npm:actual@1.0.0" } })
      writePackage(join(host, "node_modules", "alias"), { name: "actual", version: "1.0.0" })

      // when
      const sources = codemodeRuntimeDependencySources(codemode, host)

      // then
      expect(sources).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a transitive dependency cycle #when resolved #then ancestor packages are not staged twice", () => {
    // given
    const root = join(tmpdir(), `omo-codemode-cycle-${process.pid}-${crypto.randomUUID()}`)
    const codemode = join(root, "codemode")
    const host = join(root, "host")
    try {
      writePackage(codemode, { name: "codemode", version: "1.0.0", dependencies: { cycleA: "1.0.0" } })
      const cycleA = join(codemode, "node_modules", "cycleA")
      const cycleB = join(cycleA, "node_modules", "cycleB")
      writePackage(cycleA, { name: "cycleA", version: "1.0.0", dependencies: { cycleB: "1.0.0" } })
      writePackage(cycleB, { name: "cycleB", version: "1.0.0", dependencies: { cycleA: "1.0.0" } })
      writePackage(host, { name: "host", version: "1.0.0" })

      // when
      const destinations = codemodeRuntimeDependencySources(codemode, host).map((source) => source.to)

      // then
      expect(destinations).toEqual([
        "node_modules/@code-yeongyu/senpi-codemode/node_modules/cycleA",
        "node_modules/@code-yeongyu/senpi-codemode/node_modules/cycleA/node_modules/cycleB",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given every release target #when its sidecar manifest is resolved #then each OS carries codemode's full external runtime closure", () => {
    // given
    const required = [
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/lib/index.js",
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/node_modules/@babel/types/package.json",
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/node_modules/@babel/types/node_modules/@babel/helper-string-parser/package.json",
      "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/node_modules/@babel/types/node_modules/@babel/helper-validator-identifier/package.json",
    ]

    // when
    const manifests = RELEASE_BINARY_TARGETS.map((target) => ({
      os: target.os,
      target: target.target,
      files: new Set(resolveExpectedSidecarRelPaths(target)),
    }))

    // then
    expect(new Set(manifests.map((manifest) => manifest.os))).toEqual(
      new Set(["darwin", "linux", "windows"]),
    )
    for (const manifest of manifests) {
      for (const path of required) {
        expect(manifest.files.has(path), `${manifest.target} is missing ${path}`).toBe(true)
      }
    }
  })
})
