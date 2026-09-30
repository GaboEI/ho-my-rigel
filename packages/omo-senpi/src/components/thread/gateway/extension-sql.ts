import { constants } from "node:sqlite"

import { GATEWAY_TABLES } from "./schema"
import type { Sql, SqlRow } from "./sql"

export class ExtensionSchemaViolation extends Error {
  readonly code = "extension_schema_violation"
}

const COLUMNS = ["type", "name", "tbl_name", "sql"] as const
const CORE: ReadonlySet<string> = new Set(GATEWAY_TABLES)
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

export function extensionSchema(sql: Sql): readonly SqlRow[] {
  return sql.all(COLUMNS, "SELECT type, name, tbl_name, sql FROM sqlite_schema", [], "type, name")
}

function owns(name: string, object: string | null): boolean {
  return object !== null && object.startsWith(`${name}_`) && !CORE.has(object)
}

function namespaceOwner(sql: Sql, name: string): (object: string | null) => boolean {
  const others = sql.all(["name"], "SELECT name FROM extension_schema WHERE name != ?", [name]).map((row) => String(row.name))
  return (object) => owns(name, object) && !others.some((other) => other.startsWith(`${name}_`) && object?.startsWith(`${other}_`))
}

export function checkExtensionSchema(name: string, before: readonly SqlRow[], after: readonly SqlRow[]): void {
  const old = new Map(before.map((row) => [`${row.type}:${row.name}`, row]))
  const next = new Map(after.map((row) => [`${row.type}:${row.name}`, row]))
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(key)
    const b = next.get(key)
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    for (const row of [a, b]) {
      if (row !== undefined && (!owns(name, String(row.name)) || !owns(name, String(row.tbl_name)))) {
        throw new ExtensionSchemaViolation(`Extension ${name} changed an object outside its namespace: ${String(row.name)}.`)
      }
    }
  }
}

/** SQLite resolves names, subqueries and trigger/view accesses; SQL text is never used as an authorization parser. */
export function extensionSql<T>(sql: Sql, name: string, body: () => T): T {
  const owned = namespaceOwner(sql, name)
  let ddl = false
  let denied: string | undefined
  const allow = constants.SQLITE_OK
  const deny = (object: string | null): number => {
    denied = `Extension ${name} cannot access ${object ?? "this SQLite operation"}.`
    return constants.SQLITE_DENY
  }
  try {
    return sql.authorized((action, a, b, database, source) => {
      if (source !== null && !owned(source)) return deny(source)
      switch (action) {
        case constants.SQLITE_CREATE_TABLE:
        case constants.SQLITE_CREATE_VIEW:
        case constants.SQLITE_DROP_TABLE:
        case constants.SQLITE_DROP_VIEW:
          ddl = true
          return database === "main" && owned(a) ? allow : deny(a)
        case constants.SQLITE_CREATE_INDEX:
        case constants.SQLITE_DROP_INDEX:
        case constants.SQLITE_CREATE_TRIGGER:
        case constants.SQLITE_DROP_TRIGGER:
          ddl = true
          return database === "main" && owned(a) && owned(b) ? allow : deny(a)
        case constants.SQLITE_ALTER_TABLE:
          ddl = true
          return a === "main" && owned(b) ? allow : deny(b)
        case constants.SQLITE_REINDEX:
          return database === "main" && owned(a) ? allow : deny(a)
        case constants.SQLITE_READ:
        case constants.SQLITE_INSERT:
        case constants.SQLITE_UPDATE:
        case constants.SQLITE_DELETE:
          // SQLite writes sqlite_master before announcing CREATE/DROP, and ALTER rewrites both
          // schema catalogs. Direct catalog writes are disabled by SQLite; PRAGMA is denied below.
          if (a === "sqlite_master" || a === "sqlite_temp_master") {
            return action !== constants.SQLITE_READ || ddl ? allow : deny(a)
          }
          return database === "main" && owned(a) ? allow : deny(a)
        case constants.SQLITE_SELECT:
        case constants.SQLITE_RECURSIVE:
          return allow
        case constants.SQLITE_FUNCTION:
          return b === "load_extension" ? deny(b) : allow
        default:
          return deny(a)
      }
    }, body)
  } catch (error) {
    if (denied !== undefined) throw new ExtensionSchemaViolation(denied)
    throw error
  }
}

/** Trigger bodies and views are resolved lazily by SQLite; compile their use before admitting their schema. */
export function checkExtensionPrograms(sql: Sql, name: string): void {
  const schema = extensionSchema(sql)
  const owned = namespaceOwner(sql, name)
  for (const row of schema) {
    const object = String(row.name)
    if (!owned(object)) continue
    if (row.type === "view") extensionSql(sql, name, () => sql.exec(`SELECT * FROM ${quote(object)} LIMIT 0`))
    if (row.type !== "table" || !schema.some((entry) => entry.type === "trigger" && entry.tbl_name === object)) continue
    const columns = sql.all(["name"], "SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0", [object])
    extensionSql(sql, name, () => {
      sql.exec(`EXPLAIN INSERT INTO ${quote(object)} DEFAULT VALUES`)
      sql.exec(`EXPLAIN DELETE FROM ${quote(object)}`)
      sql.exec(`EXPLAIN UPDATE ${quote(object)} SET ${columns.map((column) => `${quote(String(column.name))} = ${quote(String(column.name))}`).join(", ")}`)
    })
  }
}
