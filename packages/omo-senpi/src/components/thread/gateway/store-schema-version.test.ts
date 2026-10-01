import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"

import { gatewayDatabasePath } from "./paths"
import { GATEWAY_MIGRATIONS } from "./schema"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })

test("#given a newer core schema #when an older supported version opens it #then typed refusal preserves the database", async () => {
  const h = (harness = createGatewayHarness())
  const initial = h.store()
  await initial.identity()
  await initial.dispose()
  const path = gatewayDatabasePath(h.agentDir)
  const db = new Database(path)
  const futureVersion = GATEWAY_MIGRATIONS.length + 1
  db.exec(`PRAGMA user_version = ${futureVersion}; INSERT INTO gateway_meta VALUES ('future-fixture', 'keep')`)
  db.close()
  const store = h.store()
  expect(await store.registerStoreExtension({ name: "alpha", moduleUrl: new URL("./testing/store-extension.mjs", import.meta.url).href, migrations: [] })).toMatchObject({ kind: "refused", code: "gateway_schema_too_new" })
  expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toMatchObject({ kind: "refused", code: "gateway_schema_too_new" })
  await expect(store.list()).rejects.toMatchObject({ code: "gateway_schema_too_new" })
  const check = new Database(path, { readonly: true })
  try {
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: futureVersion })
    expect(check.query("SELECT value FROM gateway_meta WHERE key='future-fixture'").get()).toEqual({ value: "keep" })
    expect(check.query("SELECT * FROM extension_schema").all()).toEqual([])
  } finally { check.close() }
})
