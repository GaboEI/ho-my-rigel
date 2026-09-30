import { extname } from "node:path"

import { checkExtensionPrograms, checkExtensionSchema, ExtensionSchemaViolation, extensionSchema, extensionSql } from "./extension-sql"
import { extensionTransaction } from "./extension-transaction"
import { singleExtensionStatement } from "./extension-statement"
import { isLockWaitExceeded } from "./lock-wait"
import { GATEWAY_TABLES } from "./schema"
import { transaction, type StoreContext } from "./store-ops"
import type { StoreExtensionOperation, StoreExtensionRefusal, StoreExtensionRegistration, StoreExtensionResult } from "./store-extensions"

type Registered = {
  readonly descriptor: StoreExtensionRegistration
  readonly module: Readonly<Record<string, unknown>>
}

function refusal(code: StoreExtensionRefusal["code"], message: string): StoreExtensionRefusal {
  return { kind: "refused", code, message }
}

function fromError(error: unknown): StoreExtensionRefusal {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ExtensionSchemaViolation) return refusal(error.code, message)
  if (isLockWaitExceeded(error)) return refusal("gateway_lock_wait_exceeded", message)
  return refusal("extension_operation_failed", message)
}

export class StoreExtensions {
  private readonly registered = new Map<string, Registered>()

  constructor(private readonly ctx: StoreContext) {}

  async register(descriptor: StoreExtensionRegistration, now: number): Promise<StoreExtensionResult<{ readonly version: number }>> {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(descriptor.name) || !Array.isArray(descriptor.migrations)
      || !descriptor.migrations.every((step) => Array.isArray(step) && step.every((sql) => typeof sql === "string"))) {
      return refusal("invalid_arguments", "An extension needs a valid namespace and an array of SQL migration steps.")
    }
    let module: Readonly<Record<string, unknown>>
    try {
      const url = new URL(descriptor.moduleUrl)
      if (url.protocol !== "file:" || ![".js", ".mjs", ".cjs"].includes(extname(url.pathname))) {
        return refusal("extension_import_failed", "moduleUrl must name a compiled JavaScript file URL.")
      }
      module = await import(descriptor.moduleUrl)
    } catch (error) {
      return refusal("extension_import_failed", `Cannot import extension ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.registered.set(descriptor.name, { descriptor, module })
    try {
      return { kind: "ok", value: { version: await this.ensure(descriptor, now) } }
    } catch (error) {
      return fromError(error)
    }
  }

  private async ensure(descriptor: StoreExtensionRegistration, now: number): Promise<number> {
    const { name, migrations } = descriptor
    for (;;) {
      const step = await transaction(this.ctx, "extension_migrate", () => {
        const row = this.ctx.sql.one(["version"], "SELECT version FROM extension_schema WHERE name = ?", [name])
        const version = Number(row?.version ?? 0)
        if (row === undefined && extensionSchema(this.ctx.sql).some((object) => String(object.name).startsWith(`${name}_`) && !GATEWAY_TABLES.some((core) => core === object.name))) {
          throw new ExtensionSchemaViolation(`Namespace ${name} already contains objects owned by another registration.`)
        }
        if (version >= migrations.length) {
          if (row === undefined) this.ctx.sql.run("INSERT INTO extension_schema (name, version, updated_at) VALUES (?, 0, ?)", [name, now])
          return { version, applied: false }
        }
        const before = extensionSchema(this.ctx.sql)
        for (const statement of migrations[version]) {
          singleExtensionStatement(statement)
          extensionSql(this.ctx.sql, name, () => this.ctx.sql.exec(statement))
        }
        checkExtensionSchema(name, before, extensionSchema(this.ctx.sql))
        checkExtensionPrograms(this.ctx.sql, name)
        this.ctx.sql.run("INSERT INTO extension_schema (name, version, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at", [name, version + 1, now])
        return { version: version + 1, applied: true }
      })
      if (!step.applied) return step.version
    }
  }

  async call(name: string, op: string, args: unknown, now: number): Promise<StoreExtensionResult<unknown>> {
    const entry = this.registered.get(name)
    if (entry === undefined) return refusal("extension_unknown_name", `No store extension is registered as ${name}.`)
    const operation = Object.hasOwn(entry.module, op) ? entry.module[op] : undefined
    if (typeof operation !== "function") return refusal("extension_unknown_op", `Extension ${name} exports no operation ${op}.`)
    const effects: (() => void)[] = []
    try {
      await this.ensure(entry.descriptor, now)
      const value = await transaction(this.ctx, "extension_call", async () => {
        const before = extensionSchema(this.ctx.sql)
        const scope = extensionTransaction({ ...this.ctx, afterCommit: effects }, name, now)
        let result: unknown
        try {
          result = await (operation as StoreExtensionOperation)(scope.tx, args)
        } finally {
          await scope.finish()
        }
        checkExtensionSchema(name, before, extensionSchema(this.ctx.sql))
        // Refuse uncloneable results before commit, not in the worker's response writer afterwards.
        return structuredClone(result)
      })
      for (const effect of effects) effect()
      return { kind: "ok", value }
    } catch (error) {
      return fromError(error)
    }
  }
}
