import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { claimEmission, emissionGuardKey, emissionGuardPath, releaseEmission } from "./rigel-v2-native-emission-guard.mjs"

const GUARD_URL = new URL("./rigel-v2-native-emission-guard.mjs", import.meta.url).href

function runRace(stateRoot, key, count, startMs) {
  const root = mkdtempSync(join(tmpdir(), "rigel-guard-child-"))
  const script = join(root, "claim.mjs")
  writeFileSync(script, [
    "const [guardUrl, stateRoot, key, start] = process.argv.slice(2)",
    "const { claimEmission } = await import(guardUrl)",
    "while (Date.now() < Number(start)) {}",
    "process.stdout.write(claimEmission({ stateRoot, key }) ? '1' : '0')",
  ].join("\n"))
  const children = []
  for (let index = 0; index < count; index++) {
    children.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [script, GUARD_URL, stateRoot, key, String(startMs)], { stdio: ["ignore", "pipe", "ignore"] })
      let output = ""
      child.stdout.on("data", (chunk) => { output += chunk })
      child.on("exit", () => resolve(output.trim()))
    }))
  }
  return Promise.all(children).finally(() => rmSync(root, { recursive: true, force: true }))
}

describe("emission guard", () => {
  let stateRoot

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "rigel-emission-"))
  })

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true })
  })

  test("#given one key #then the first claim wins and the next is suppressed", () => {
    const key = emissionGuardKey("question", "ses_1", "frm_1")
    expect(claimEmission({ stateRoot, key, now: () => 1000 })).toBe(true)
    expect(claimEmission({ stateRoot, key, now: () => 1000 })).toBe(false)
  })

  test("#given the ttl elapsed #then the key can be reclaimed", () => {
    const key = emissionGuardKey("permission", "ses_1", "per_1")
    expect(claimEmission({ stateRoot, key, ttlMs: 1000, now: () => 1000 })).toBe(true)
    expect(claimEmission({ stateRoot, key, ttlMs: 1000, now: () => 1500 })).toBe(false)
    expect(claimEmission({ stateRoot, key, ttlMs: 1000, now: () => 2500 })).toBe(true)
  })

  test("#given a release #then the key can be claimed again", () => {
    const key = emissionGuardKey("question", "ses_1", "frm_1")
    expect(claimEmission({ stateRoot, key, now: () => 1000 })).toBe(true)
    releaseEmission({ stateRoot, key })
    expect(claimEmission({ stateRoot, key, now: () => 1000 })).toBe(true)
  })

  test("#given distinct keys #then they are independent", () => {
    const a = emissionGuardKey("question", "ses_1", "frm_1")
    const b = emissionGuardKey("question", "ses_2", "frm_1")
    expect(claimEmission({ stateRoot, key: a })).toBe(true)
    expect(claimEmission({ stateRoot, key: b })).toBe(true)
  })

  test("#given a stale lock #then a later claim steals it and proceeds", () => {
    const key = emissionGuardKey("question", "ses_1", "frm_lock")
    // Seed an expired record plus a lock whose holder died (old mtime).
    const file = emissionGuardPath(stateRoot, key)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ key, at: 0 }))
    writeFileSync(`${file}.lock`, "dead-holder")
    const past = new Date(Date.now() - 60_000)
    utimesSync(`${file}.lock`, past, past)
    expect(claimEmission({ stateRoot, key, ttlMs: 1, lockTtlMs: 2000 })).toBe(true)
    // The lock is always removed, so it never suppresses future claims forever.
    expect(readdirSync(dirname(file)).some((name) => name.endsWith(".lock"))).toBe(false)
  })

  test("#given a corrupt record #then it is treated as fresh until the ttl", () => {
    const key = emissionGuardKey("question", "ses_1", "frm_corrupt")
    const file = emissionGuardPath(stateRoot, key)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{not json")
    expect(claimEmission({ stateRoot, key, ttlMs: 60000 })).toBe(false)
  })

  test("#given operations #then no lock or temp files are left behind", () => {
    const key = emissionGuardKey("question", "ses_1", "frm_clean")
    claimEmission({ stateRoot, key, now: () => 1000 })
    claimEmission({ stateRoot, key, now: () => 1000 })
    claimEmission({ stateRoot, key, ttlMs: 10, now: () => 5000 })
    const leftovers = readdirSync(join(stateRoot, "oh-my-rigel/emitted")).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })

  test("#given a crafted key #then the guard file cannot escape the guard directory", () => {
    const path = emissionGuardPath(stateRoot, "question:../../evil:req")
    expect(path.startsWith(join(stateRoot, "oh-my-rigel/emitted"))).toBe(true)
  })

  test("#given a missing key or state root #then the guard fails open", () => {
    expect(claimEmission({ stateRoot, key: "" })).toBe(true)
    expect(claimEmission({ key: "x" })).toBe(true)
  })

  test("#given many concurrent processes #then exactly one claims the key", async () => {
    const key = emissionGuardKey("permission", "ses_race", "per_race")
    const startMs = Date.now() + 600
    const results = await runRace(stateRoot, key, 8, startMs)
    const winners = results.filter((result) => result === "1")
    expect(winners).toHaveLength(1)
    expect(results.filter((result) => result === "0")).toHaveLength(7)
  }, 30000)

  test("#given many concurrent processes and an expired key #then exactly one reclaims it", async () => {
    const key = emissionGuardKey("question", "ses_race2", "frm_expired")
    const file = emissionGuardPath(stateRoot, key)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ key, at: 0 }))
    const startMs = Date.now() + 600
    const results = await runRace(stateRoot, key, 8, startMs)
    expect(results.filter((result) => result === "1")).toHaveLength(1)
  }, 30000)
})
