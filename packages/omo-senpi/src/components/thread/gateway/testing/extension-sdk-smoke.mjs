import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const { createThreadSdk } = await import(pathToFileURL(resolve("packages/omo-senpi/plugin/runtime/thread-sdk/sdk.js")).href)
const agentDir = mkdtempSync(join(tmpdir(), "store-extension-sdk-"))
const sdk = createThreadSdk({ agentDir, cwd: agentDir, uid: 12345, user: "fixture" })
const moduleUrl = new URL("./store-extension.mjs", import.meta.url).href
const dbPath = join(agentDir, "gateway", "gateway.sqlite")
try {
  for (const name of ["alpha", "omo_gateway"]) {
    assert.deepEqual(await sdk.registerStoreExtension({ name, moduleUrl, migrations: [[`CREATE TABLE ${name}_items (id INTEGER PRIMARY KEY, value TEXT)`]] }), { kind: "ok", value: { version: 1 } })
  }
  assert.deepEqual(await sdk.extensionCall("omo_gateway", "put", { name: "omo_gateway", id: 1, value: "compiled SDK" }), { kind: "ok", value: { value: "compiled SDK" } })
  assert.equal((await sdk.registerStoreExtension({ name: "gateway", moduleUrl, migrations: [] })).code, "extension_schema_violation")
  assert.equal((await sdk.extensionCall("omo_gateway", "sql", { sql: "DELETE FROM gateway_meta" })).code, "extension_schema_violation")
  const bound = await sdk.extensionCall("alpha", "core", { op: "bind", request: { principal: "fixture", binding: { platform: "custom", account_id: "bot", chat_id: "chat", session_durable_id: "target", ttl_seconds: null } } })
  assert.equal(bound.kind, "ok")
  assert.equal(bound.value.kind, "ok")
  const request = { binding_id: bound.value.binding.binding_id, event_id: "rolled-back", text: "hello", author: { platform_user_id: "p1", display: "Alice", user_id: "u1" } }
  const inbox = join(agentDir, "gateway", "inbox", "target")
  const failed = await sdk.extensionCall("alpha", "enqueueThenThrow", { request, inbox })
  assert.deepEqual(failed, { kind: "refused", code: "extension_operation_failed", message: "rollback requested" })
  assert.deepEqual(existsSync(inbox) ? readdirSync(inbox) : [], [])
  const db = new Database(dbPath, { readonly: true })
  try {
    assert.deepEqual(db.query("SELECT COUNT(*) AS n FROM deliveries").get(), { n: 0 })
    assert.deepEqual(db.query("SELECT owner FROM extension_objects WHERE name = 'omo_gateway_items'").get(), { owner: "omo_gateway" })
  } finally { db.close() }
  assert.deepEqual(await sdk.extensionCall("omo_gateway", "rows", { name: "omo_gateway" }), { kind: "ok", value: [{ id: 1, value: "compiled SDK" }] })
  console.log("PASS compiled SDK: registration, registry, reserved namespace, truncate refusal, joined rollback, marker isolation, worker recovery")
} finally {
  await sdk.dispose()
  rmSync(agentDir, { recursive: true, force: true })
  assert.equal(existsSync(agentDir), false)
  console.log("CLEANUP compiled SDK: worker disposed; directory REMOVED")
}
