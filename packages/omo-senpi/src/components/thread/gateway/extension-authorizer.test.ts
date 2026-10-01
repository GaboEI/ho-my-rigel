import { afterEach, expect, test } from "bun:test"
import { constants, DatabaseSync } from "node:sqlite"

import { ExtensionSchemaViolation, extensionSql } from "./extension-sql"
import { gatewayDatabasePath } from "./paths"
import { Sql } from "./sql"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })

test.each([
  ["trigger", constants.SQLITE_CREATE_TRIGGER, "CREATE TRIGGER alpha_hook AFTER INSERT ON alpha_items BEGIN SELECT 1; END"],
  ["view", constants.SQLITE_CREATE_VIEW, "CREATE VIEW alpha_view AS SELECT id FROM alpha_items"],
] as const)("#given direct SQLite %s creation #when authorizing #then its specific create action is denied", async (_kind, action, statement) => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension({ name: "alpha", moduleUrl: new URL("./testing/store-extension.mjs", import.meta.url).href, migrations: [["CREATE TABLE alpha_items (id INTEGER)"]] })
  const db = new DatabaseSync(gatewayDatabasePath(h.agentDir))
  const decisions: { action: number; decision: number }[] = []
  const sql = new Sql({
    exec: db.exec.bind(db),
    function: db.function.bind(db),
    close: db.close.bind(db),
    setAuthorizer: (authorize) => db.setAuthorizer(authorize === null ? null : (...args) => {
      const decision = authorize(...args)
      decisions.push({ action: args[0], decision })
      return decision
    }),
  })
  try {
    // Drive SQLite directly: neither the lexical guard nor the schema-diff guard runs here.
    expect(() => extensionSql(sql, "alpha", () => sql.exec(statement))).toThrow(ExtensionSchemaViolation)
    expect(decisions.filter((entry) => entry.action === action).map((entry) => entry.decision)).toEqual([constants.SQLITE_DENY])
  } finally { db.close() }
  expect(await store.list()).toEqual([])
})
