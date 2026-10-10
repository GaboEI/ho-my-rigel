/**
 * Shared seal primitives for the web data source.
 * Used by both build-seal.mjs (generation) and source.test.ts (verification),
 * so the two can never disagree on the canonical form or the hash input.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export const SCHEMA_VERSION = 1
export const BASELINE_COMMIT = "de96488614d9117bc078390decf81cb9690e4be1"
export const SEALED_FILES = ["catalog.json", "agents.json", "chains.json", "cli.json", "i18n/catalog.en.json", "guide.json", "i18n/guide.en.json"]

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function readSourceJson(baseUrl, name) {
  return JSON.parse(readFileSync(new URL(name, baseUrl), "utf8"))
}

export function computeDataSha256(baseUrl) {
  const canonical = SEALED_FILES.map((name) => {
    return `${name}\n${stableStringify(readSourceJson(baseUrl, name))}`
  }).join("\n")
  return createHash("sha256").update(canonical).digest("hex")
}
