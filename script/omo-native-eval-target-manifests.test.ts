import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { RELEASE_BINARY_TARGETS, collectStagedFiles, resolveExpectedSidecarRelPaths } from "./build-omo-binary"
import { engineSidecarSources } from "./engine-sidecar-sources"

const repoRoot = join(import.meta.dir, "..")
const packageSchema = z.object({
  name: z.string(),
  os: z.array(z.string()),
  cpu: z.array(z.string()),
  files: z.array(z.string()),
})

describe("compiled eval target manifests", () => {
  test("ships the same derived codemode sidecars for all twelve platform package manifests", () => {
    // Given: discover the platform packages independently of the release target list.
    const manifests = readdirSync(join(repoRoot, "packages"))
      .filter((name) => name.startsWith("oh-my-opencode-"))
      .map((name) => packageSchema.parse(JSON.parse(
        readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"),
      )))
    const codemodeRoot = "node_modules/@code-yeongyu/senpi-codemode"
    const expected = new Set<string>()
    for (const source of engineSidecarSources().filter((entry) => entry.to.startsWith(codemodeRoot))) {
      // Directory sources own the package contents; explicit wasm entries overlap them.
      const files = source.to.endsWith(".wasm") ? [""] : collectStagedFiles(source.from)
      for (const file of files.filter((path) => !path.endsWith(".map"))) {
        const path = file === "" ? source.to : `${source.to}/${file}`
        expected.add(path)
      }
    }

    // When: resolve the binary manifest corresponding to each package.
    const targets = manifests.map((manifest) => {
      const slug = manifest.name.slice("oh-my-opencode-".length)
      const target = RELEASE_BINARY_TARGETS.find((entry) => entry.target === slug)
      if (target === undefined) throw new Error(`no binary target for ${manifest.name}`)
      const files = resolveExpectedSidecarRelPaths(target).filter((path) => path.startsWith(codemodeRoot))
      return { manifest, target, files }
    })

    // Then: cross-platform variants preserve every common sidecar.
    expect(targets).toHaveLength(12)
    expect(new Set(targets.map(({ target }) => target.target))).toEqual(
      new Set(RELEASE_BINARY_TARGETS.map((target) => target.target)),
    )
    expect(expected.size).toBeGreaterThan(0)
    for (const { manifest, target, files } of targets) {
      expect(manifest.os).toEqual([target.os === "windows" ? "win32" : target.os])
      expect(manifest.cpu).toEqual([target.target.includes("arm64") ? "arm64" : "x64"])
      expect(manifest.files).toContain("bin")
      expect(files, target.target).toEqual([...expected].sort())
    }
  })

  test("dispatches eval to every executable release leg including musl containers", () => {
    // Given
    const workflow = readFileSync(join(repoRoot, ".github/workflows/publish-platform.yml"), "utf8")
    const native = workflow.slice(workflow.indexOf('case "$TARGET" in'), workflow.indexOf("  publish:"))
    const arm64 = workflow.slice(workflow.indexOf("  smoke-linux-arm64:"))
    // When / Then: these are executable command contracts, not prose snapshots.
    expect(native).toMatch(/darwin-arm64[\s\S]*omo-native-eval-smoke\.mjs[\s\S]*omo-darwin-arm64/)
    for (const pattern of [
      /linux-x64\|linux-x64-baseline\)([\s\S]*?);;/,
      /windows-x64\|windows-x64-baseline\)([\s\S]*?);;/,
    ]) {
      expect(native.match(pattern)?.[1]).toContain('bun script/qa/omo-native-eval-smoke.mjs "$BIN"')
    }
    const musl = workflow.slice(workflow.indexOf("          musl_smoke()"), workflow.indexOf("          verify_checksum"))
    expect(musl).toContain('node script/qa/omo-native-eval-smoke.mjs ${BIN}')
    expect(workflow).toMatch(/apk add --no-cache[^"\n]*python3[^"\n]*nodejs/)
    expect(workflow).toContain('node script/qa/omo-native-eval-smoke.mjs')
    expect(arm64).toContain("bun script/qa/omo-native-eval-smoke.mjs .omo/release-binaries/omo-linux-arm64")
    expect(arm64).toContain("node script/qa/omo-native-eval-smoke.mjs .omo/release-binaries/omo-linux-arm64-musl")
  })
})
