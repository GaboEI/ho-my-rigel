/**
 * Pure core for Oh My Rigel's native OpenCode V2 task-progress toasts.
 *
 * V1 `features/task-toast-manager/` tracked delegated/background tasks and
 * surfaced their progress in the TUI: a list toast on every add / model change
 * ("New Background Task" / "New Task Executed") and a completion toast with the
 * still-running remainder. It read its UI effect through `client.tui.showToast`
 * and its concurrency limit through `ConcurrencyManager`.
 *
 * This module is the behavioural port, made pure and renderer-free: the toast
 * SINK is injected (`showToast(toast) => void`) and the concurrency limit is an
 * injected function, so every branch is deterministic and unit-testable without
 * a TUI. The V2 companion CLI plugin (`rigel-v2-native-cli-task-toast.mjs`) is
 * the adapter that turns V2 events into the manager calls and forwards the sink
 * to `context.ui.toast.show`.
 *
 * V1 sources ported here:
 *   packages/omo-opencode/src/features/task-toast-manager/manager.ts
 *   packages/omo-opencode/src/features/task-toast-manager/types.ts
 *
 * Message shapes are the V1 `en` locale strings verbatim:
 *   "New Background Task" / "New Task Executed" / "Task Completed"
 *   "Running ({{count}}):" / "Queued ({{count}}):" / " [{{total}}/{{limit}}]"
 *   "[FALLBACK] Model: {{model}}{{suffix}}" with the inherited / system-default /
 *   runtime-fallback suffixes, the "[BG]"/"[RUN]"/"[Q]"/"[W]" prefixes, the
 *   " - {{duration}}" tail and the " ← NEW" marker.
 */

/** V1 `toast.new_background_task` / `toast.new_task_executed` / `toast.task_completed`. */
export const TASK_TOAST_TITLES = Object.freeze({
  newBackgroundTask: "New Background Task",
  newTaskExecuted: "New Task Executed",
  taskCompleted: "Task Completed",
})

/** V1 toast variants used by the list (`info`) and completion (`success`) toasts. */
export const TASK_TOAST_VARIANTS = Object.freeze({
  info: "info",
  success: "success",
})

/**
 * V1 duration rule: a list toast lasts 5000ms when more than two tasks are
 * tracked (running + queued), otherwise 3000ms; a completion toast is 5000ms.
 */
export const TASK_TOAST_DURATION = Object.freeze({
  idle: 3000,
  crowded: 5000,
  completion: 5000,
  crowdedThreshold: 2,
})

/** V1 `toast.fallback_*` suffixes, keyed by the fallback type that earns them. */
export const FALLBACK_SUFFIXES = Object.freeze({
  inherited: " (inherited from parent)",
  "system-default": " (system default fallback)",
  "runtime-fallback": " (runtime fallback)",
})

/** V1 `formatTaskIdentifier` inputs, matching the `model: category` rule. */
function formatTaskIdentifier(task) {
  const modelName = task?.modelInfo?.model?.split("/").pop()
  if (modelName && task.category) return `${modelName}: ${task.category}`
  if (modelName) return modelName
  if (task.category) return `${task.agent}/${task.category}`
  return task.agent
}

/**
 * V1 `formatDuration`: `Ns`, `Nm Ss`, or `Hh Mm`, computed from a start instant
 * against "now". Accepts a `Date` or an epoch millis number for the start so a
 * caller may keep either representation.
 */
export function formatDuration(startedAt, now) {
  const started = startedAt instanceof Date ? startedAt.getTime() : Number(startedAt)
  const current = typeof now === "number" ? now : Date.now()
  const seconds = Math.floor((current - started) / 1000)
  if (!Number.isFinite(seconds) || seconds < 60) return `${Number.isFinite(seconds) ? seconds : 0}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function isFallbackType(type) {
  return type === "inherited" || type === "system-default" || type === "runtime-fallback"
}

/**
 * V1 `getConcurrencyInfo`: with a limit present and finite it appends
 * ` [total/limit]`; with no manager or an `Infinity` limit it adds nothing.
 */
export function formatConcurrencyInfo({ running, queued, limit }) {
  if (typeof limit !== "number" || limit === Infinity) return ""
  return ` [${running + queued}/${limit}]`
}

/**
 * V1 `buildTaskListMessage`, made a pure function of its inputs.
 *
 * The NEW task is already part of `running`/`queued`, exactly as V1 computes it
 * after `addTask` has stored the task. Fallback prefixes are emitted first with
 * a trailing blank line, then running tasks (newest first), then queued tasks
 * (oldest first), separated by a blank line when both blocks are present.
 */
export function buildTaskListMessage({ newTask, running = [], queued = [], limit, now }) {
  const concurrencyInfo = formatConcurrencyInfo({ running: running.length, queued: queued.length, limit })
  const lines = []

  const fallbackType = newTask?.modelInfo?.type
  if (newTask?.modelInfo && isFallbackType(fallbackType)) {
    const suffix = FALLBACK_SUFFIXES[fallbackType] ?? ""
    lines.push(`[FALLBACK] Model: ${newTask.modelInfo.model}${suffix}`)
    lines.push("")
  }

  if (running.length > 0) {
    lines.push(`Running (${running.length}):${concurrencyInfo}`)
    for (const task of running) {
      const duration = formatDuration(task.startedAt, now)
      const bgIcon = task.isBackground ? "[BG]" : "[RUN]"
      const isNew = task.id === newTask?.id ? " ← NEW" : ""
      const skillsInfo = task.skills?.length ? ` [${task.skills.join(", ")}]` : ""
      lines.push(`${bgIcon} ${task.description} (${formatTaskIdentifier(task)})${skillsInfo} - ${duration}${isNew}`)
    }
  }

  if (queued.length > 0) {
    if (lines.length > 0) lines.push("")
    lines.push(`Queued (${queued.length}):`)
    for (const task of queued) {
      const bgIcon = task.isBackground ? "[Q]" : "[W]"
      const isNew = task.id === newTask?.id ? " ← NEW" : ""
      const skillsInfo = task.skills?.length ? ` [${task.skills.join(", ")}]` : ""
      lines.push(`${bgIcon} ${task.description} (${formatTaskIdentifier(task)})${skillsInfo} - Queued${isNew}`)
    }
  }

  return lines.join("\n")
}

/**
 * V1 `TaskToastManager`, reimplemented as a factory over an injected sink.
 *
 *   showToast(toast)            required sink; `{ title, message, variant, duration }`
 *   getConcurrencyLimit(key)    optional; `"default"` is asked, `Infinity` disables
 *                               the ` [total/limit]` suffix
 *   now()                       optional clock seam, default `Date.now`
 *
 * The returned manager owns a `Map<id, TrackedTask>`; `TrackedTask` /
 * `ModelFallbackInfo` keep the V1 shape (`startedAt` is a `Date`).
 */
export function createTaskToastManager({ showToast, getConcurrencyLimit, now } = {}) {
  const tasks = new Map()
  const sink = typeof showToast === "function" ? showToast : () => {}
  const clock = typeof now === "function" ? now : () => Date.now()
  const limitFor = typeof getConcurrencyLimit === "function" ? getConcurrencyLimit : undefined

  function getRunningTasks() {
    return Array.from(tasks.values())
      .filter((task) => task.status === "running")
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  }

  function getQueuedTasks() {
    return Array.from(tasks.values())
      .filter((task) => task.status === "queued")
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  }

  function currentLimit() {
    if (!limitFor) return undefined
    try {
      return limitFor("default")
    } catch {
      return undefined
    }
  }

  function getConcurrencyInfo() {
    const limit = currentLimit()
    return formatConcurrencyInfo({ running: getRunningTasks().length, queued: getQueuedTasks().length, limit })
  }

  function buildTaskListMessageFor(newTask) {
    return buildTaskListMessage({
      newTask,
      running: getRunningTasks(),
      queued: getQueuedTasks(),
      limit: currentLimit(),
      now: clock(),
    })
  }

  function showTaskListToast(task) {
    const newTask = task && typeof task === "object" ? task : Array.from(tasks.values())[tasks.size - 1]
    if (!newTask) return
    const running = getRunningTasks()
    const queued = getQueuedTasks()
    const message = buildTaskListMessageFor(newTask)
    const title = newTask.isBackground ? TASK_TOAST_TITLES.newBackgroundTask : TASK_TOAST_TITLES.newTaskExecuted
    const crowded = running.length + queued.length > TASK_TOAST_DURATION.crowdedThreshold
    sink({
      title,
      message: message || `${newTask.description} (${newTask.agent})`,
      variant: TASK_TOAST_VARIANTS.info,
      duration: crowded ? TASK_TOAST_DURATION.crowded : TASK_TOAST_DURATION.idle,
    })
  }

  function addTask(task) {
    if (!task || typeof task.id !== "string" || task.id.length === 0) return
    const tracked = {
      id: task.id,
      sessionID: task.sessionID,
      description: task.description,
      agent: task.agent,
      status: task.status ?? "running",
      startedAt: task.startedAt instanceof Date ? task.startedAt : new Date(clock()),
      isBackground: task.isBackground === true,
      category: task.category,
      skills: task.skills,
      modelInfo: task.modelInfo,
    }
    tasks.set(task.id, tracked)
    showTaskListToast(tracked)
  }

  function updateTask(id, status) {
    const task = tasks.get(id)
    if (task) task.status = status
  }

  function updateTaskModelBySession(sessionID, modelInfo) {
    if (!sessionID) return
    const task = Array.from(tasks.values()).find((candidate) => candidate.sessionID === sessionID)
    if (!task) return
    if (task.modelInfo?.model === modelInfo?.model && task.modelInfo?.type === modelInfo?.type) return
    task.modelInfo = modelInfo
    showTaskListToast(task)
  }

  function removeTask(id) {
    tasks.delete(id)
  }

  function showCompletionToast(task) {
    if (!task || typeof task.id !== "string") return
    removeTask(task.id)
    const remaining = getRunningTasks()
    const queued = getQueuedTasks()
    let message = `"${task.description}" finished in ${task.duration}`
    if (remaining.length > 0 || queued.length > 0) {
      message += `\n\nStill running: ${remaining.length} | Queued: ${queued.length}`
    }
    sink({
      title: TASK_TOAST_TITLES.taskCompleted,
      message,
      variant: TASK_TOAST_VARIANTS.success,
      duration: TASK_TOAST_DURATION.completion,
    })
  }

  return {
    addTask,
    updateTask,
    updateTaskModelBySession,
    removeTask,
    getRunningTasks,
    getQueuedTasks,
    showTaskListToast,
    showCompletionToast,
    getConcurrencyInfo,
    size: () => tasks.size,
  }
}

export default createTaskToastManager
