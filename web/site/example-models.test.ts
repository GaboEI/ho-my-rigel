import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The example-model snapshot is consumed by two owners: the blocking gate in check.mjs reads `models`
// (each copyable example model must be listed here), and the network lane reads `source`, `fetchedAt`
// and `catalogSha256`. This guards the file's machine-consumed shape, not its prose.

const doc = JSON.parse(readFileSync(new URL("./example-models.json", import.meta.url), "utf8")) as {
  schemaVersion: number
  source: string
  fetchedAt: string
  catalogSha256: string
  models: string[]
}

describe("#given the example-model snapshot #when its fields are read #then the provenance and model ids are well-formed", () => {
  test("#given the snapshot #when validated #then source is the models.dev URL, the hash is sha256, the date is ISO and ids are provider/model", () => {
    // given / when / then
    expect(doc.schemaVersion).toBe(1)
    expect(doc.source).toBe("https://models.dev/api.json")
    expect(/^[0-9a-f]{64}$/.test(doc.catalogSha256)).toBe(true)
    expect(/^\d{4}-\d{2}-\d{2}$/.test(doc.fetchedAt)).toBe(true)
    expect(doc.models.length).toBeGreaterThan(0)
    for (const id of doc.models) {
      expect([id, /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/.test(id)]).toEqual([id, true])
    }
  })
})
