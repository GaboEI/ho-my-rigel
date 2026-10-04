/**
 * Native V2 port of OmO's `task_create` / `task_get` / `task_list` /
 * `task_update` family.
 *
 * Source oracles:
 * - `packages/omo-opencode/src/tools/task/` (tool schemas, response contracts,
 *   additive update semantics)
 * - `packages/omo-opencode/src/features/claude-tasks/storage.ts` (id generation,
 *   atomic persistence, bounded lock, invalid-record tolerance)
 *
 * The V1 implementation persisted one JSON file per task under
 * `.omo/tasks/<listId>/` and guarded writes with a file lock. This port keeps
 * every observable contract and moves persistence onto the V2 `ctx.storage`
 * domain, with an in-process bounded lock preserving the
 * `task_lock_unavailable` / `retryable` contract under contention.
 */

const TASK_STATUS_VALUES = ["pending", "in_progress", "completed", "deleted"]
const TASK_ID_PATTERN = /^T-[A-Za-z0-9-]+$/

export const TASK_CREATE_DESCRIPTION = `Create a new task with auto-generated ID and threadID recording.

Auto-generates T-{uuid} ID, records threadID from context, sets status to "pending".
Returns minimal response with task ID and subject.

**IMPORTANT - Dependency Planning for Parallel Execution:**
Use \`blockedBy\` to specify task IDs that must complete before this task can start.
Calculate dependencies carefully to maximize parallel execution:
- Tasks with no dependencies can run simultaneously
- Only block a task if it truly depends on another's output
- Minimize dependency chains to reduce sequential bottlenecks`

export const TASK_GET_DESCRIPTION = `Retrieve a task by ID.

Returns the full task object including all fields: id, subject, description, status, activeForm, blocks, blockedBy, owner, metadata, repoURL, parentID, and threadID.

Returns null if the task does not exist or the file is invalid.`

export const TASK_LIST_DESCRIPTION = `List all active tasks with summary information.
    
Returns tasks excluding completed and deleted statuses by default.
For each task's blockedBy field, filters to only include unresolved (non-completed) blockers.
Returns summary format: id, subject, status, owner, blockedBy (not full description).`

export const TASK_UPDATE_DESCRIPTION = `Update an existing task with new values.

Supports updating: subject, description, status, activeForm, owner, metadata.
For blocks/blockedBy: use addBlocks/addBlockedBy to append (additive, not replacement).
For metadata: merge with existing, set key to null to delete.
Syncs to OpenCode Todo API after update.

**IMPORTANT - Dependency Management:**
Use \`addBlockedBy\` to declare dependencies on other tasks.
Properly managed dependencies enable maximum parallel execution.`

export const TASK_LIST_REMINDER = "1 task = 1 task. Maximize parallel execution by running independent tasks (tasks with empty blockedBy) concurrently."

// ---------------------------------------------------------------------------
// Pure validation / normalization (mirrors the V1 Zod schemas without a dep)
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validationError(message) {
  const error = new Error(message)
  error.name = "ValidationError"
  return error
}

export function isValidTaskId(id) {
  return typeof id === "string" && TASK_ID_PATTERN.test(id)
}

const TASK_OBJECT_KEYS = new Set([
  "id", "subject", "description", "status", "activeForm", "blocks", "blockedBy",
  "owner", "metadata", "repoURL", "parentID", "threadID",
])

/**
 * Validate and normalize a persisted task record. Returns `null` for any
 * malformed record, matching V1 `readJsonSafe` + strict-schema behavior.
 */
export function parseTaskObject(value) {
  if (!isPlainObject(value)) return null
  for (const key of Object.keys(value)) {
    if (!TASK_OBJECT_KEYS.has(key)) return null
  }
  if (typeof value.id !== "string" || !value.id) return null
  if (typeof value.subject !== "string") return null
  if (typeof value.description !== "string") return null
  if (!TASK_STATUS_VALUES.includes(value.status)) return null
  if (typeof value.threadID !== "string") return null
  const optionalStrings = ["activeForm", "owner", "repoURL", "parentID"]
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null
  }
  if (value.blocks !== undefined && !Array.isArray(value.blocks)) return null
  if (value.blockedBy !== undefined && !Array.isArray(value.blockedBy)) return null
  if (value.blocks !== undefined && !value.blocks.every((entry) => typeof entry === "string")) return null
  if (value.blockedBy !== undefined && !value.blockedBy.every((entry) => typeof entry === "string")) return null
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) return null
  return {
    id: value.id,
    subject: value.subject,
    description: value.description,
    status: value.status,
    ...(value.activeForm !== undefined ? { activeForm: value.activeForm } : {}),
    blocks: value.blocks ?? [],
    blockedBy: value.blockedBy ?? [],
    ...(value.owner !== undefined ? { owner: value.owner } : {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    ...(value.repoURL !== undefined ? { repoURL: value.repoURL } : {}),
    ...(value.parentID !== undefined ? { parentID: value.parentID } : {}),
    threadID: value.threadID,
  }
}

export function parseTaskCreateInput(args) {
  if (!isPlainObject(args)) throw validationError("Required: subject")
  if (typeof args.subject !== "string") throw validationError("Required: subject")
  const optionalStrings = ["description", "activeForm", "owner", "repoURL", "parentID"]
  for (const key of optionalStrings) {
    if (args[key] !== undefined && typeof args[key] !== "string") throw validationError(`Invalid type for ${key}`)
  }
  for (const key of ["blocks", "blockedBy"]) {
    if (args[key] !== undefined && (!Array.isArray(args[key]) || !args[key].every((entry) => typeof entry === "string"))) {
      throw validationError(`Invalid type for ${key}`)
    }
  }
  if (args.metadata !== undefined && !isPlainObject(args.metadata)) throw validationError("Invalid type for metadata")
  return args
}

export function parseTaskUpdateInput(args) {
  if (!isPlainObject(args)) throw validationError("Required: id")
  if (typeof args.id !== "string") throw validationError("Required: id")
  if (args.status !== undefined && !TASK_STATUS_VALUES.includes(args.status)) throw validationError("Invalid status")
  const optionalStrings = ["subject", "description", "activeForm", "owner", "repoURL", "parentID"]
  for (const key of optionalStrings) {
    if (args[key] !== undefined && typeof args[key] !== "string") throw validationError(`Invalid type for ${key}`)
  }
  for (const key of ["addBlocks", "addBlockedBy"]) {
    if (args[key] !== undefined && (!Array.isArray(args[key]) || !args[key].every((entry) => typeof entry === "string"))) {
      throw validationError(`Invalid type for ${key}`)
    }
  }
  if (args.metadata !== undefined && !isPlainObject(args.metadata)) throw validationError("Invalid type for metadata")
  return args
}

/** V1 additive update semantics: scalars replace, arrays dedupe-append, metadata merges with null deletes. */
export function applyTaskUpdate(task, input) {
  const next = { ...task }
  if (input.subject !== undefined) next.subject = input.subject
  if (input.description !== undefined) next.description = input.description
  if (input.status !== undefined) next.status = input.status
  if (input.activeForm !== undefined) next.activeForm = input.activeForm
  if (input.owner !== undefined) next.owner = input.owner
  if (input.parentID !== undefined) next.parentID = input.parentID
  if (input.repoURL !== undefined) next.repoURL = input.repoURL
  if (input.addBlocks) next.blocks = [...new Set([...task.blocks, ...input.addBlocks])]
  if (input.addBlockedBy) next.blockedBy = [...new Set([...task.blockedBy, ...input.addBlockedBy])]
  if (input.metadata !== undefined) {
    const merged = { ...task.metadata, ...input.metadata }
    for (const key of Object.keys(merged)) {
      if (merged[key] === null) delete merged[key]
    }
    next.metadata = merged
  }
  return parseTaskObject(next)
}

export function taskSummary(task, byId) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    owner: task.owner,
    blockedBy: task.blockedBy.filter((blockerId) => {
      const blocker = byId.get(blockerId)
      return !blocker || blocker.status !== "completed"
    }),
  }
}

// ---------------------------------------------------------------------------
// V1 listId / lock / id generation
// ---------------------------------------------------------------------------

export function sanitizePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-") || "default"
}

export function resolveTaskListId({ env = process.env, config = {}, cwd = process.cwd() } = {}) {
  const envId = env.ULTRAWORK_TASK_LIST_ID?.trim()
  if (envId) return sanitizePathSegment(envId)
  const claudeEnvId = env.CLAUDE_CODE_TASK_LIST_ID?.trim()
  if (claudeEnvId) return sanitizePathSegment(claudeEnvId)
  const configId = config?.sisyphus?.tasks?.task_list_id?.trim()
  if (configId) return sanitizePathSegment(configId)
  const base = String(cwd).split(/[\\/]/).filter(Boolean).pop() ?? "default"
  return sanitizePathSegment(base)
}

export const STALE_LOCK_THRESHOLD_MS = 30_000
export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5_000

export function resolveLockWaitTimeoutMs(env = process.env) {
  const raw = env.OMO_TASK_LOCK_WAIT_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_LOCK_WAIT_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOCK_WAIT_TIMEOUT_MS
  return parsed
}

/**
 * In-process bounded mutex. V1 used a file lock; per-key V2 storage writes are
 * already atomic, so this lock only preserves the observable contention
 * contract (`acquired:false` -> `task_lock_unavailable`).
 */
export function createTaskLock({ waitTimeoutMs = resolveLockWaitTimeoutMs(), retryDelayMs = 10, now = () => Date.now(), sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let held = false
  const acquire = async () => {
    const deadline = now() + waitTimeoutMs
    while (held) {
      if (now() >= deadline) return { acquired: false, release() {} }
      await wait(Math.max(1, Math.min(retryDelayMs, deadline - now())))
    }
    held = true
    return {
      acquired: true,
      release() {
        held = false
      },
    }
  }
  return { acquire }
}

export function createTaskIdFactory({ randomUUID } = {}) {
  const uuid = randomUUID ?? ((() => {
    let counter = 0
    return () => `${Date.now().toString(36)}-${(counter++).toString(36)}`
  })())
  return () => `T-${uuid()}`
}

// ---------------------------------------------------------------------------
// V2 storage-backed task store
// ---------------------------------------------------------------------------

function defaultTaskKey(prefix, listId, id) {
  return `${prefix}/${listId}/${id}`
}

/**
 * Task persistence over `ctx.storage`. One key per task; `scan` enumerates a
 * list. Malformed values are dropped, matching V1's invalid-file tolerance.
 */
export function createV2TaskStore({ storage, prefix = "rigel-v2/tasks", listId, key = defaultTaskKey } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("createV2TaskStore requires the V2 storage domain with get/set")
  }

  const taskKey = (id) => key(prefix, listId, id)

  return {
    keyFor: taskKey,
    async readTask(id) {
      const value = await storage.get(taskKey(id))
      return value === undefined ? null : parseTaskObject(value)
    },
    async writeTask(task) {
      await storage.set(taskKey(task.id), task)
    },
    async listTasks() {
      if (typeof storage.scan !== "function") return []
      const tasks = []
      let after
      do {
        const page = await storage.scan({ prefix: `${prefix}/${listId}/`, limit: 100, ...(after ? { after } : {}) })
        for (const entry of page?.entries ?? []) {
          const parsed = parseTaskObject(entry?.value)
          if (parsed) tasks.push(parsed)
        }
        after = page?.next
      } while (after)
      return tasks
    },
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TASK_CREATE_INPUT = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Task subject (required)" },
    description: { type: "string", description: "Task description" },
    activeForm: { type: "string", description: "Active form (present continuous)" },
    metadata: { type: "object", additionalProperties: true, description: "Task metadata" },
    blockedBy: { type: "array", items: { type: "string" }, description: "Task IDs blocking this task" },
    blocks: { type: "array", items: { type: "string" }, description: "Task IDs this task blocks" },
    repoURL: { type: "string", description: "Repository URL" },
    parentID: { type: "string", description: "Parent task ID" },
  },
  required: ["subject"],
  additionalProperties: false,
}

export const TASK_GET_INPUT = {
  type: "object",
  properties: { id: { type: "string", description: "Task ID to retrieve (format: T-{uuid})" } },
  required: ["id"],
  additionalProperties: false,
}

export const TASK_LIST_INPUT = {
  type: "object",
  properties: {
    status: { type: "string", enum: TASK_STATUS_VALUES, description: "Filter by status" },
    parentID: { type: "string", description: "Filter by parent task ID" },
  },
  additionalProperties: false,
}

export const TASK_UPDATE_INPUT = {
  type: "object",
  properties: {
    id: { type: "string", description: "Task ID (required)" },
    subject: { type: "string", description: "Task subject" },
    description: { type: "string", description: "Task description" },
    status: { type: "string", enum: TASK_STATUS_VALUES, description: "Task status" },
    activeForm: { type: "string", description: "Active form (present continuous)" },
    owner: { type: "string", description: "Task owner (agent name)" },
    addBlocks: { type: "array", items: { type: "string" }, description: "Task IDs to add to blocks (additive, not replacement)" },
    addBlockedBy: { type: "array", items: { type: "string" }, description: "Task IDs to add to blockedBy (additive, not replacement)" },
    metadata: { type: "object", additionalProperties: true, description: "Task metadata to merge (set key to null to delete)" },
  },
  required: ["id"],
  additionalProperties: false,
}

function sessionIDFrom(context, fallback) {
  if (typeof context?.sessionID === "string" && context.sessionID) return context.sessionID
  return fallback
}

/**
 * Create the four task tools. `store` is the V2 storage-backed store; `lock`
 * guards a read-modify-write; `syncTodos` is the V1 OpenCode-todo mirror seam
 * (V2 has no session.todo write API, so the runtime can inject a real writer or
 * leave it null; tool responses are unaffected either way).
 */
export function createTaskTools({ store, lock, idFactory = createTaskIdFactory(), syncTodos, getSessionID } = {}) {
  if (!store || typeof store.readTask !== "function") {
    throw new TypeError("createTaskTools requires a task store")
  }
  const taskLock = lock ?? createTaskLock()

  const runUnderLock = async (work) => {
    const handle = await taskLock.acquire()
    if (!handle.acquired) return { locked: true }
    try {
      return { locked: false, value: await work() }
    } finally {
      handle.release()
    }
  }

  const taskCreate = {
    name: "task_create",
    options: { codemode: false },
    description: TASK_CREATE_DESCRIPTION,
    input: TASK_CREATE_INPUT,
    async execute(args = {}, context = {}) {
      try {
        const input = parseTaskCreateInput(args)
        const threadID = sessionIDFrom(context, undefined)
        if (threadID === undefined) return JSON.stringify({ error: "internal_error" })
        let task
        const outcome = await runUnderLock(async () => {
          task = parseTaskObject({
            id: idFactory(),
            subject: input.subject,
            description: input.description ?? "",
            status: "pending",
            blocks: input.blocks ?? [],
            blockedBy: input.blockedBy ?? [],
            activeForm: input.activeForm,
            metadata: input.metadata,
            repoURL: input.repoURL,
            parentID: input.parentID,
            threadID,
          })
          if (!task) throw new Error("invalid task record")
          await store.writeTask(task)
          return task
        })
        if (outcome.locked) return JSON.stringify({ error: "task_lock_unavailable", retryable: true })
        task = outcome.value
        await syncTodos?.(task, threadID)
        return JSON.stringify({ task: { id: task.id, subject: task.subject } })
      } catch (error) {
        if (error instanceof Error && error.message.includes("Required")) {
          return JSON.stringify({ error: "validation_error", message: error.message })
        }
        return JSON.stringify({ error: "internal_error" })
      }
    },
  }

  const taskGet = {
    name: "task_get",
    options: { codemode: false },
    description: TASK_GET_DESCRIPTION,
    input: TASK_GET_INPUT,
    async execute(args = {}) {
      try {
        if (!isValidTaskId(args.id)) return JSON.stringify({ error: "invalid_task_id" })
        const task = await store.readTask(args.id)
        return JSON.stringify({ task: task ?? null })
      } catch (error) {
        if (error instanceof Error && error.message.includes("validation")) {
          return JSON.stringify({ error: "invalid_arguments" })
        }
        return JSON.stringify({ error: "unknown_error" })
      }
    },
  }

  const taskList = {
    name: "task_list",
    options: { codemode: false },
    description: TASK_LIST_DESCRIPTION,
    input: TASK_LIST_INPUT,
    async execute() {
      const tasks = await store.listTasks()
      const byId = new Map(tasks.map((task) => [task.id, task]))
      const active = tasks.filter((task) => task.status !== "completed" && task.status !== "deleted")
      return JSON.stringify({ tasks: active.map((task) => taskSummary(task, byId)), reminder: TASK_LIST_REMINDER })
    },
  }

  const taskUpdate = {
    name: "task_update",
    options: { codemode: false },
    description: TASK_UPDATE_DESCRIPTION,
    input: TASK_UPDATE_INPUT,
    async execute(args = {}, context = {}) {
      try {
        const input = parseTaskUpdateInput(args)
        if (!isValidTaskId(input.id)) return JSON.stringify({ error: "invalid_task_id" })
        let updated
        const outcome = await runUnderLock(async () => {
          const existing = await store.readTask(input.id)
          if (!existing) return null
          const next = applyTaskUpdate(existing, input)
          if (!next) throw new Error("invalid task record")
          await store.writeTask(next)
          return next
        })
        if (outcome.locked) return JSON.stringify({ error: "task_lock_unavailable", retryable: true })
        updated = outcome.value
        if (!updated) return JSON.stringify({ error: "task_not_found" })
        const threadID = sessionIDFrom(context, updated.threadID)
        await syncTodos?.(updated, threadID)
        return JSON.stringify({ task: updated })
      } catch (error) {
        if (error instanceof Error && error.message.includes("Required")) {
          return JSON.stringify({ error: "validation_error", message: error.message })
        }
        return JSON.stringify({ error: "internal_error" })
      }
    },
  }

  return { task_create: taskCreate, task_get: taskGet, task_list: taskList, task_update: taskUpdate }
}

export const TASK_TOOL_NAMES = ["task_create", "task_get", "task_list", "task_update"]
