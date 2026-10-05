export function reconcileStaleWorks(state, now, thresholdMs = 6 * 60 * 60 * 1000) {
  if (!state?.works) return state
  let changed = false
  for (const work of Object.values(state.works)) {
    if (work.status !== "active") continue
    const activity = Date.parse(work.updated_at ?? work.started_at ?? "")
    if (!Number.isFinite(activity) || now.getTime() - activity >= thresholdMs) {
      work.status = "paused"
      work.stale_since = now.toISOString()
      changed = true
    }
  }
  if (!changed) return state
  const active = state.works[state.active_work_id]
  if (active) Object.assign(state, active)
  return state
}
