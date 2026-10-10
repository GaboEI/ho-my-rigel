import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"

// Network lane (NOT part of `web:check`): verifies that each pinned example-model id is still present
// in the live models.dev catalog that OpenCode V2 uses (opencode.ai/v2/docs/providers). It does NOT
// recompute the snapshot hash (the live catalog changes over time) and never writes the file. The
// blocking build never touches the network, so a transient outage cannot fail the publication gate.
const CATALOG_URL = "https://models.dev/api.json"
const snapshot = JSON.parse(await readFile(new URL("example-models.json", import.meta.url), "utf8"))

const response = await fetch(CATALOG_URL)
if (!response.ok) {
  console.error(`FAIL cannot fetch ${CATALOG_URL}: HTTP ${response.status}`)
  process.exit(1)
}
const text = await response.text()
const catalog = JSON.parse(text)

console.log(`catalog: ${CATALOG_URL}`)
console.log(`snapshot provenance (recorded at pin time, NOT asserted): fetchedAt=${snapshot.fetchedAt} catalogSha256=${snapshot.catalogSha256}`)
console.log(`live catalog sha256 (informational; differs as the catalog changes): ${createHash("sha256").update(text).digest("hex")}`)
let missing = 0
for (const id of snapshot.models) {
  const [provider, model] = id.split("/")
  const present = Boolean(catalog[provider]?.models?.[model])
  console.log(`  ${present ? "PRESENT" : "ABSENT "}  ${id}`)
  if (!present) missing += 1
}
if (missing > 0) {
  console.error(`FAIL ${missing} example model(s) are absent from the live catalog; update example-models.json`)
  process.exit(1)
}
console.log(`PASS verify-example-models.mjs (${snapshot.models.length} example models present in the live catalog)`)
