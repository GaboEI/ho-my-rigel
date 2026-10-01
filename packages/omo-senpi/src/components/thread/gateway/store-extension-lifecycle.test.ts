import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { GatewayResolution } from "./engine"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })
const moduleUrl = new URL("./testing/extension-lifecycle.mjs", import.meta.url).href

test.each(["hang", "staleTimer"])("#given an extension %s #when its lifetime ends #then the worker and write lock remain usable", async (scenario) => {
  // A separate client process lets the watchdog reap a regressed, wedged worker as well.
  const agentDir = mkdtempSync(join(tmpdir(), "gateway-lifecycle-"))
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./testing/extension-lifecycle-driver.mjs", import.meta.url)), scenario, agentDir], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
    expect(result).toMatchObject({ rows: { kind: "ok", value: [] }, core: [] })
    if (scenario === "hang") expect(result).toMatchObject({ outcome: { kind: "refused", code: "extension_operation_failed" }, otherWriter: "ok" })
    else expect(result).toMatchObject({ event: { kind: "extension_error", phase: "stale_transaction" } })
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill()
    await child.exited
    rmSync(agentDir, { recursive: true, force: true })
  }
}, 20_000)

test.each(["staleSync", "staleAsync"])("#given retained tx #when %s is called #then the caller receives a typed error and the worker survives", async (operation) => {
  const h = (harness = createGatewayHarness())
  const store = h.store()
  await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [["CREATE TABLE alpha_items (id INTEGER PRIMARY KEY, value TEXT)"]] })
  await store.extensionCall("alpha", "retain", null)
  expect(await store.extensionCall("alpha", operation, null)).toEqual({
    kind: "ok", value: { code: "extension_operation_failed", ...(operation === "staleAsync" ? { synchronous: false } : {}) },
  })
  expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toEqual({ kind: "ok", value: [] })
  expect(await store.list()).toEqual([])
})

test.each(["pending", "failed"])("#given an unawaited helper with %s resolution #when finishing #then its failure rolls back without late writes or worker loss", async (mode) => {
  const h = (harness = createGatewayHarness())
  const requested = Promise.withResolvers<void>()
  const resolution = Promise.withResolvers<GatewayResolution>()
  const store = h.store({
    _test: { busyTimeoutMs: 10, lockWaitMaxMs: 60 },
    resolveTarget: async () => {
      requested.resolve()
      if (mode === "failed") throw new Error("resolution failed")
      return await resolution.promise
    },
  })
  await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [["CREATE TABLE alpha_items (id INTEGER PRIMARY KEY, value TEXT)"]] })
  const bound = await store.extensionCall<{ kind: "ok"; binding: { binding_id: string } }>("alpha", "core", {
    op: "bind", request: { principal: "fixture", binding: { platform: "custom", account_id: "bot", chat_id: "chat", session_durable_id: "target", ttl_seconds: null } },
  })
  if (bound.kind !== "ok") throw new Error(JSON.stringify(bound))
  const call = store.extensionCall("alpha", "unawaitedEnqueue", { binding_id: bound.value.binding.binding_id, event_id: "pending", text: "hello" })
  await Promise.race([requested.promise, call.then(() => { throw new Error("The call returned without resolving its target.") })])
  expect(await call).toMatchObject({ kind: "refused", code: "extension_operation_failed" })
  resolution.resolve({ kind: "ok", target: { durable_id: "target", endpoint: null, liveness: "dead" } })
  expect(await store.list()).toEqual([])
  expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toEqual({ kind: "ok", value: [] })
})
