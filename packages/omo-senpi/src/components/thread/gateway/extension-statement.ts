import { ExtensionSchemaViolation } from "./extension-sql"

/** Each SQL API call is one statement, including a trigger body. Namespace authorization is SQLite's job. */
export function singleExtensionStatement(sql: string): void {
  const words: string[] = []
  let trigger = false
  let depth = 0
  let ended = false
  const wordChar = (c: string): boolean => c !== "" && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_")
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
    if (wordChar(c)) {
      const start = i++
      while (wordChar(sql[i] ?? "")) i++
      const word = sql.slice(start, i).toUpperCase()
      words.push(word)
      if (words[0] === "CREATE" && word === "TRIGGER" && words.length <= 3) trigger = true
      if (trigger && (word === "BEGIN" || word === "CASE")) depth++
      if (trigger && word === "END") depth--
      continue
    }
    if (c === ";" && depth === 0) ended = true
    i++
  }
}
