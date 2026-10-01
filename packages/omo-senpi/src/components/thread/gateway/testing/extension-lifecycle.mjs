export * from "./store-extension.mjs"

let retained

export function hang(tx) {
  tx.exec("INSERT INTO alpha_items VALUES (1, 'uncommitted')")
  return new Promise(() => {})
}

export function retain(tx) {
  retained = tx
  return null
}

export function staleSync() {
  try { retained.exec("INSERT INTO alpha_items VALUES (2, 'stale')") }
  catch (error) { return { code: error.code } }
}

export async function staleAsync() {
  let result
  try { result = retained.bindingFor({ platform: "custom", account_id: "bot", chat_id: "chat", thread_id: "@chat" }) }
  catch (error) { return { synchronous: true, code: error.code } }
  try { await result }
  catch (error) { return { synchronous: false, code: error.code } }
}

export function staleTimer() {
  setTimeout(() => retained.exec("INSERT INTO alpha_items VALUES (3, 'timer')"), 0)
  return null
}
