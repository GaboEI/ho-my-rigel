// Rigel V2 CLI `boulder`.
//
// Inspector for the NATIVE V2 boulder/continuity state. The real store is the
// one the V2 runtime writes, defined in
// `profiles/gabo/opencode/rigel-v2-ulw-execute.mjs` (`boulderPath` / `writeState`):
//
//   `<directory>/.omo/boulder.json`
//   { schema_version: 2, active_work_id, works: { <work_id>: work }, ...mirrorOfWork }
//   work = { work_id, active_plan, plan_name, status, started_at, updated_at,
//            session_ids, session_origins, agent, worktree_path?, task_sessions }
//
// Same path the V1 CLI inspector
// (`packages/omo-opencode/src/cli/boulder/boulder.ts`) read through
// `@oh-my-opencode/boulder-state`; here it is read and rendered directly so the
// V2 CLI carries no V1 dependency. Plan progress reuses the native
// `getPlanProgress` primitive. It never launches OpenCode.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { getPlanProgress } from "../../opencode/rigel-v2-native-plan-format-validator.mjs"
import { fail, parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

const ALLOWED_OPTIONS = new Set(["directory", "work-id", "json"])
const SEPARATOR = "----------------------------------------"

const SECTION_BOUNDARY = /^#{1,2}(?:[ \t]+|$)/
const TODO_HEADING = /^##[ \t]+TODOs(?:[ \t]+#+)?[ \t]*$/i
const FINAL_WAVE_HEADING = /^##[ \t]+Final Verification Wave(?:[ \t]+#+)?[ \t]*$/i
const STRUCTURED_CHECKBOX = /^- \[([ xX~])\] (.+)$/
const TODO_LABEL = /^([1-9]\d*|T[1-9]\d*(?:\.[1-9]\d*[a-z]?)?)(?:\.[ \t]+|[ \t]+(?:[-\u2014][ \t]+)?)(.+)$/i
const FINAL_WAVE_LABEL = /^([FH][1-9]\d*(?:\.[1-9]\d*[a-z]?)?)(?:\.[ \t]+|[ \t]+(?:[-\u2014][ \t]+)?)(.+)$/i
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/

function boulderPath(directory) {
  return path.join(directory, ".omo", "boulder.json")
}

/**
 * Read the store. Distinguishes a missing file (exit 1) from an unreadable or
 * malformed one (exit 2), so a broken state is never reported as "no work".
 */
function readState(file) {
  if (!existsSync(file)) return { missing: true }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: true }
    return { state: parsed }
  } catch {
    return { error: true }
  }
}

/** Works from the `works` map, falling back to a legacy single-work record. */
function getWorks(state) {
  const works = state?.works
  if (works && typeof works === "object" && !Array.isArray(works) && Object.keys(works).length > 0) {
    return Object.values(works).filter((work) => work && typeof work === "object")
  }
  if (typeof state?.work_id === "string" || typeof state?.active_plan === "string") return [state]
  return []
}

function toAbsolute(baseDirectory, trackedPath) {
  return path.isAbsolute(trackedPath) ? path.resolve(trackedPath) : path.resolve(baseDirectory, trackedPath)
}

/** Resolve the plan file, preferring the worktree copy when one exists (V1 parity). */
function resolvePlanPath(directory, work) {
  if (typeof work.active_plan !== "string" || !work.active_plan) return ""
  const absoluteDirectory = path.resolve(directory)
  const absolutePlanPath = toAbsolute(absoluteDirectory, work.active_plan)
  const worktreePath = typeof work.worktree_path === "string" ? work.worktree_path.trim() : ""
  if (!worktreePath) return absolutePlanPath
  const relativePlanPath = path.relative(absoluteDirectory, absolutePlanPath)
  if (relativePlanPath.length === 0 || relativePlanPath.startsWith("..") || path.isAbsolute(relativePlanPath)) {
    return absolutePlanPath
  }
  const worktreePlanPath = path.resolve(toAbsolute(absoluteDirectory, worktreePath), relativePlanPath)
  return existsSync(worktreePlanPath) ? worktreePlanPath : absolutePlanPath
}

function parseOpeningFence(line) {
  const match = line.match(FENCE_OPEN)
  const run = match?.[1]
  const info = match?.[2]
  if (run === undefined || info === undefined) return null
  const marker = run.charAt(0)
  if (marker !== "`" && marker !== "~") return null
  if (marker === "`" && info.includes("`")) return null
  return { marker, length: run.length }
}

function isClosingFence(line, fence) {
  const run = line.match(FENCE_CLOSE)?.[1]
  return run?.charAt(0) === fence.marker && run.length >= fence.length
}

/**
 * The first open top-level task of the plan, mirroring the V1
 * `readCurrentTopLevelTask` structured grammar: `## TODOs` -> `N.` / `T<n>`,
 * `## Final Verification Wave` -> `F<n>` / `H<n>`. `[x]` and `[~]` are skipped.
 * Returns null for a simple/legacy checklist with no structured section.
 */
function readCurrentTopLevelTask(planPath) {
  if (!planPath || !existsSync(planPath)) return null
  let content
  try {
    content = readFileSync(planPath, "utf8")
  } catch {
    return null
  }
  let section = "other"
  let fence = null
  for (const line of content.split(/\r?\n/)) {
    if (fence !== null) {
      if (isClosingFence(line, fence)) fence = null
      continue
    }
    const opening = parseOpeningFence(line)
    if (opening !== null) {
      fence = opening
      continue
    }
    if (SECTION_BOUNDARY.test(line)) {
      section = TODO_HEADING.test(line) ? "todo" : FINAL_WAVE_HEADING.test(line) ? "final-wave" : "other"
      continue
    }
    if (section === "other") continue
    const checkbox = line.match(STRUCTURED_CHECKBOX)
    if (!checkbox) continue
    const marker = checkbox[1]
    if (marker.toLowerCase() === "x" || marker === "~") continue
    const task = checkbox[2].match(section === "todo" ? TODO_LABEL : FINAL_WAVE_LABEL)
    if (!task) continue
    return { key: `${section}:${task[1].toLowerCase()}`, section, label: task[1], title: task[2] }
  }
  return null
}

function formatDurationHuman(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined
  if (durationMs < 1000) return `${durationMs}ms`
  const totalSeconds = Math.floor(durationMs / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Elapsed from an explicit `elapsed_ms`, else started/ended timestamps. */
function elapsedMsFor(work, now) {
  if (typeof work.elapsed_ms === "number" && Number.isFinite(work.elapsed_ms)) return work.elapsed_ms
  const startedMs = Date.parse(work.started_at ?? "")
  if (Number.isNaN(startedMs)) return undefined
  const endedMs = work.ended_at ? Date.parse(work.ended_at) : now
  if (Number.isNaN(endedMs)) return undefined
  return Math.max(0, endedMs - startedMs)
}

function buildWork(directory, work, now) {
  const planPath = resolvePlanPath(directory, work)
  const progress = planPath ? getPlanProgress(planPath) : { total: 0, completed: 0 }
  const elapsedMs = elapsedMsFor(work, now)
  const currentTask = readCurrentTopLevelTask(planPath)
  const sessionCount = Array.isArray(work.session_ids) ? work.session_ids.length : 0

  let currentTaskElapsedHuman
  if (currentTask) {
    const taskSession = work.task_sessions?.[currentTask.key]
    if (typeof taskSession?.elapsed_ms === "number") {
      currentTaskElapsedHuman = formatDurationHuman(taskSession.elapsed_ms)
    } else if (typeof taskSession?.started_at === "string") {
      const startedMs = Date.parse(taskSession.started_at)
      if (!Number.isNaN(startedMs)) currentTaskElapsedHuman = formatDurationHuman(Math.max(0, now - startedMs))
    }
  }

  return {
    work_id: work.work_id,
    plan_name: work.plan_name,
    active_plan: work.active_plan,
    ...(work.worktree_path ? { worktree_path: work.worktree_path } : {}),
    status: work.status ?? "active",
    started_at: work.started_at,
    ...(work.ended_at ? { ended_at: work.ended_at } : {}),
    ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs, elapsed_human: formatDurationHuman(elapsedMs) } : {}),
    total_tasks: progress.total,
    completed_tasks: progress.completed,
    remaining_tasks: Math.max(0, progress.total - progress.completed),
    percentage: progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
    session_count: sessionCount,
    ...(currentTask
      ? {
        current_task: {
          task_key: currentTask.key,
          task_title: currentTask.title,
          ...(currentTaskElapsedHuman ? { elapsed_human: currentTaskElapsedHuman } : {}),
        },
      }
      : {}),
  }
}

function formatCurrentTask(work) {
  if (!work.current_task) return "-"
  const elapsed = work.current_task.elapsed_human ? ` (${work.current_task.elapsed_human})` : ""
  return `${work.current_task.task_title}${elapsed}`
}

function formatWorkText(work) {
  return [
    `plan: ${work.plan_name}`,
    `status: ${work.status}`,
    `progress: ${work.percentage}% (${work.completed_tasks}/${work.total_tasks})`,
    `elapsed: ${work.elapsed_human ?? "-"}`,
    `sessions: ${work.session_count}`,
    `current task: ${formatCurrentTask(work)}`,
  ].join("\n")
}

function reportMissing(io, json, code) {
  io.stderr.write(`${json ? JSON.stringify({ error: "No boulder state found." }) : "No boulder state found."}\n`)
  return code
}

export const boulderCommand = {
  name: "boulder",
  summary: "Inspect the native Rigel V2 boulder/continuity state",
  usage: "rigel-v2 boulder [--directory <dir>] [--work-id <id>] [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const unknown = Object.keys(options).find((key) => !ALLOWED_OPTIONS.has(key))
    if (unknown) return fail(io, `unknown option --${unknown}`)

    const directory = typeof options.directory === "string" ? options.directory : (io.cwd ?? process.cwd())
    const json = options.json === true

    const read = readState(boulderPath(directory))
    if (read.missing) return reportMissing(io, json, 1)
    if (read.error) {
      io.stderr.write(`${json ? JSON.stringify({ error: "Failed to read boulder state." }) : "Failed to read boulder state."}\n`)
      return 2
    }

    const works = getWorks(read.state)
    const requestedWorkId = typeof options["work-id"] === "string" ? options["work-id"] : undefined
    const filtered = requestedWorkId ? works.filter((work) => work.work_id === requestedWorkId) : works
    if (filtered.length === 0) return reportMissing(io, json, 1)

    const now = Date.now()
    const rendered = filtered.map((work) => buildWork(directory, work, now))
    if (json) {
      writeJson(io, { works: rendered })
    } else {
      io.stdout.write(`${["boulder progress", ...rendered.map(formatWorkText)].join(`\n${SEPARATOR}\n`)}\n`)
    }
    return 0
  },
}
