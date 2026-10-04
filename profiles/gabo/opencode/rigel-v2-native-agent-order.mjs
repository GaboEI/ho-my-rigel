/**
 * Canonical agent ordering for Oh My Rigel's native OpenCode V2 runtime.
 *
 * Plain-JS port of the matching OmO revision:
 *   packages/omo-opencode/src/shared/agent-ordering.ts:3-8
 *     DEFAULT_AGENT_ORDER = ["sisyphus", "hephaestus", "prometheus", "atlas"]
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so the order
 * lives here as plain functions. `rigel-v2-native-agent-order.test.mjs` imports
 * the real TS owners and pins parity, so upstream drift fails the suite.
 *
 * Ordering is applied at three boundaries so it never depends on incidental V2
 * host order: agent registration (`rigel-v2-native-agents.mjs`), the
 * inventory-derived callable roster (`rigel-v2-native-core.mjs`, which feeds
 * both roster injection and delegation), and manifest generation
 * (`generate-v2-agents.mjs`).
 */

export const CANONICAL_AGENT_KEYS = ["sisyphus", "hephaestus", "prometheus", "atlas"]

/**
 * Normalize an agent display name or id to its config key:
 * "Sisyphus - ultraworker" -> "sisyphus", "Prometheus - Plan Builder" ->
 * "prometheus", "explore" -> "explore". An unknown or absent name normalizes
 * to its trimmed lowercase form, which is never a canonical key unless it
 * matches one.
 */
export function canonicalAgentKey(name) {
  return String(name ?? "").trim().toLocaleLowerCase().split(/\s+-\s+/)[0].trim()
}

/**
 * Stable partition. Returns a NEW array (never mutates the input): every agent
 * whose `canonicalAgentKey(agent?.name ?? agent?.id)` is a canonical core key,
 * in CANONICAL_AGENT_KEYS order, followed by every remaining agent in input
 * order. Non-object or unnamed entries keep their relative input order in the
 * remainder.
 */
export function sortAgentsByCanonicalOrder(agents) {
  const input = Array.isArray(agents) ? agents : []
  const buckets = new Map(CANONICAL_AGENT_KEYS.map((key) => [key, []]))
  const remainder = []
  for (const agent of input) {
    const key = canonicalAgentKey(agent?.name ?? agent?.id)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(agent)
    else remainder.push(agent)
  }
  const ordered = []
  for (const key of CANONICAL_AGENT_KEYS) ordered.push(...buckets.get(key))
  return [...ordered, ...remainder]
}
