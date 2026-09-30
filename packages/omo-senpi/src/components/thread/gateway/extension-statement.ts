import { ExtensionSchemaViolation } from "./extension-sql"

/** Keep statement-scoped catalog authorization from carrying into another statement. */
export function singleExtensionStatement(sql: string): void {
  let ended = false
  for (let i = 0; i < sql.length;) {
    const c = sql[i]
    if (c <= " ") { i++; continue }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++
      continue
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (ended) throw new ExtensionSchemaViolation("An extension SQL call must contain one statement.")
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = c === "[" ? "]" : c
      i++
      while (i < sql.length) {
        if (sql[i++] !== end) continue
        if (c !== "[" && sql[i] === end) { i++; continue }
        break
      }
      continue
    }
    if (c === ";") ended = true
    i++
  }
}
