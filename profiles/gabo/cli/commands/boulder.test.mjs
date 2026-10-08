/**
 * Module contract for the Rigel V2 CLI `boulder` command: drives the real
 * `run(argv, io)` against a temp `.omo/boulder.json` written in the real native
 * V2 shape, with a captured io. POSITIVE and NEGATIVE rows per branch: json and
 * text rendering, a missing store, an unreadable store, work-id filtering and a
 * refused flag.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { boulderCommand } from "./boulder.mjs"

const created = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

function captureIo(overrides = {}) {
  const out = []
  const err = []
  const io = {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    env: {},
    cwd: overrides.cwd ?? process.cwd(),
    spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    text: () => out.join(""),
    errors: () => err.join(""),
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "cwd" || key === "env") continue
    io[key] = value
  }
  return io
}

function writePlan(directory, name, body) {
  mkdirSync(join(directory, ".omo", "plans"), { recursive: true })
  const file = join(directory, ".omo", "plans", name)
  writeFileSync(file, body)
  return file
}

function writeState(directory, state) {
  mkdirSync(join(directory, ".omo"), { recursive: true })
  writeFileSync(join(directory, ".omo", "boulder.json"), JSON.stringify(state, null, 2))
}

const PLAN_BODY = "# Wave\n\n## TODOs\n\n- [ ] 1. Implement the thing\n- [x] 2. Done already\n"

function nativeState(directory, { planName = "wave", ...work } = {}) {
  const planPath = writePlan(directory, `${planName}.md`, PLAN_BODY)
  const workId = `${planName}-20261005`
  const entry = {
    work_id: workId,
    active_plan: planPath,
    plan_name: planName,
    status: "active",
    started_at: "2026-10-05T10:00:00.000Z",
    updated_at: "2026-10-05T10:01:00.000Z",
    session_ids: ["opencode:ses_1", "opencode:ses_2"],
    session_origins: {},
    agent: "atlas",
    task_sessions: {},
    ...work,
  }
  return { schema_version: 2, active_work_id: workId, works: { [workId]: entry }, ...entry }
}

describe("#given the boulder command", () => {
  test("#when native work is read as json #then it reports plan, progress, elapsed, sessions and the current task", async () => {
    const directory = tempDir("rigel-boulder-")
    writeState(directory, nativeState(directory, { elapsed_ms: 65000 }))
    const io = captureIo()
    expect(await boulderCommand.run(["--directory", directory, "--json"], io)).toBe(0)
    const payload = JSON.parse(io.text())
    expect(payload.works).toHaveLength(1)
    const work = payload.works[0]
    expect(work.plan_name).toBe("wave")
    expect(work.status).toBe("active")
    expect(work.total_tasks).toBe(2)
    expect(work.completed_tasks).toBe(1)
    expect(work.percentage).toBe(50)
    expect(work.elapsed_human).toBe("1m 5s")
    expect(work.session_count).toBe(2)
    expect(work.current_task.task_key).toBe("todo:1")
    expect(work.current_task.task_title).toBe("Implement the thing")
  })

  test("#when native work is read as text #then the work block is rendered", async () => {
    const directory = tempDir("rigel-boulder-")
    writeState(directory, nativeState(directory, { elapsed_ms: 65000 }))
    const io = captureIo()
    expect(await boulderCommand.run(["--directory", directory], io)).toBe(0)
    const text = io.text()
    expect(text).toContain("boulder progress")
    expect(text).toContain("plan: wave")
    expect(text).toContain("status: active")
    expect(text).toContain("progress: 50% (1/2)")
    expect(text).toContain("elapsed: 1m 5s")
    expect(text).toContain("sessions: 2")
    expect(text).toContain("current task: Implement the thing")
  })

  test("#when the elapsed is derived from timestamps #then the human duration is computed", async () => {
    const directory = tempDir("rigel-boulder-")
    writeState(directory, nativeState(directory, {
      started_at: "2026-10-05T10:00:00.000Z",
      ended_at: "2026-10-05T10:02:05.000Z",
    }))
    const io = captureIo()
    expect(await boulderCommand.run(["--directory", directory, "--json"], io)).toBe(0)
    expect(JSON.parse(io.text()).works[0].elapsed_human).toBe("2m 5s")
  })

  test("#when no boulder state exists #then it exits 1 with the no-state message on stderr", async () => {
    const directory = tempDir("rigel-boulder-")
    const textIo = captureIo()
    expect(await boulderCommand.run(["--directory", directory], textIo)).toBe(1)
    expect(textIo.errors()).toContain("No boulder state found.")

    const jsonIo = captureIo()
    expect(await boulderCommand.run(["--directory", directory, "--json"], jsonIo)).toBe(1)
    expect(jsonIo.errors()).toContain(JSON.stringify({ error: "No boulder state found." }))
  })

  test("#when the boulder state is unreadable #then it exits 2 with the read-error message", async () => {
    const directory = tempDir("rigel-boulder-")
    mkdirSync(join(directory, ".omo"), { recursive: true })
    writeFileSync(join(directory, ".omo", "boulder.json"), "{not-json")
    const io = captureIo()
    expect(await boulderCommand.run(["--directory", directory], io)).toBe(2)
    expect(io.errors()).toContain("Failed to read boulder state.")
  })

  test("#given two works #when a work id is selected #then only that work renders and an unknown id fails", async () => {
    const directory = tempDir("rigel-boulder-")
    const first = nativeState(directory, { planName: "wave" })
    const second = nativeState(directory, { planName: "slate" })
    writeState(directory, {
      schema_version: 2,
      active_work_id: first.active_work_id,
      works: { ...first.works, ...second.works },
      ...first.works[first.active_work_id],
    })

    const io = captureIo()
    expect(await boulderCommand.run(["--directory", directory, "--work-id", "slate-20261005", "--json"], io)).toBe(0)
    const payload = JSON.parse(io.text())
    expect(payload.works).toHaveLength(1)
    expect(payload.works[0].plan_name).toBe("slate")

    const miss = captureIo()
    expect(await boulderCommand.run(["--directory", directory, "--work-id", "absent"], miss)).toBe(1)
    expect(miss.errors()).toContain("No boulder state found.")
  })

  test("#given a legacy state without a works map #when read #then the top-level work renders", async () => {
    const directory = tempDir("rigel-boulder-")
    const planPath = writePlan(directory, "legacy.md", "# Legacy\n\n- [ ] only task\n")
    writeState(directory, {
      active_plan: planPath,
      plan_name: "legacy",
      work_id: "legacy-1",
      status: "active",
      started_at: "2026-10-05T10:00:00.000Z",
      elapsed_ms: 1000,
      session_ids: ["opencode:ses_1"],
    })
    const io = captureIo()
    expect(await boulderCommand.run(["--directory", directory, "--json"], io)).toBe(0)
    const payload = JSON.parse(io.text())
    expect(payload.works).toHaveLength(1)
    expect(payload.works[0].plan_name).toBe("legacy")
    expect(payload.works[0].elapsed_human).toBe("1s")
  })

  test("#when an unknown flag is given #then the command is refused with exit 1", async () => {
    const directory = tempDir("rigel-boulder-")
    writeState(directory, nativeState(directory))
    const io = captureIo()
    expect(await boulderCommand.run(["--directory", directory, "--bogus"], io)).toBe(1)
    expect(io.errors()).toContain("unknown option")
  })
})
