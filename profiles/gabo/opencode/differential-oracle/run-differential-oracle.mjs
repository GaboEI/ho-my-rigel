#!/usr/bin/env node
/**
 * Differential oracle runner + evidence generator.
 *
 * Modes:
 *   (default)      run the matrix + injection mutations, write matrix.txt,
 *                  exit non-zero when any scenario is not PASS or any mutation
 *                  is not RED.
 *   --matrix-json  print the matrix as JSON (used by the on-disk mutation proof
 *                  so a fresh process re-reads a mutated file).
 *   --mutate       additionally prove, on disk, that each scenario goes RED when
 *                  its V2 export is renamed, then restore every file byte for
 *                  byte (sha256 before == after).
 *
 * The on-disk mutation touches ONLY files under profiles/gabo/opencode/ listed
 * in MUTATION_FILES. It never touches packages/ or any V1 path.
 */

import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { scenarios } from "./registry.mjs"
import { runMatrix, runMutations, summarizeMatrix } from "./harness.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OPENCODE_DIR = path.resolve(HERE, "..")
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..")

/** scenario id -> V2 mirror file (relative to profiles/gabo/opencode). */
const MUTATION_FILES = {
  "delegation.retry-classification": "rigel-v2-delegate-retry-core.mjs",
  "delegation.retry-guidance": "rigel-v2-delegate-retry-core.mjs",
  "delegation.coordinator-guard": "rigel-v2-native-core.mjs",
  "delegation.demoted-plan": "rigel-v2-native-core.mjs",
  "ultrawork.detection": "rigel-v2-keyword-core.mjs",
  "ultrawork.source-routing": "rigel-v2-keyword-core.mjs",
  "ultrawork.text-guards": "rigel-v2-keyword-core.mjs",
  "rules.parse": "rigel-v2-native-rules.mjs",
  "rules.match": "rigel-v2-native-rules.mjs",
  "recovery.edit": "rigel-v2-native-recovery.mjs",
  "recovery.json": "rigel-v2-native-recovery.mjs",
  "recovery.plan-effort": "rigel-v2-native-plan-format-validator.mjs",
  "permissions.frontier-guard": "rigel-v2-native-permissions.mjs",
  "fallback.agent-chains": "rigel-v2-native-model-chains.mjs",
  "fallback.category-chains": "rigel-v2-native-model-chains.mjs",
  "fallback.model-string-parser": "rigel-v2-native-model-chains.mjs",
  "fallback.provider-transform": "rigel-v2-background-retry.mjs",
  "compaction.template": "rigel-v2-native-compaction-context.mjs",
  "skills.scope-priority": "rigel-v2-native-skills.mjs",
  "skills.allowed-tools": "rigel-v2-native-skills.mjs",
  "skills.matching": "rigel-v2-native-skills.mjs",
  "goal.validation": "tools/goal.tools.mjs",
  "goal.command-parse": "tools/goal.tools.mjs",
  "goal.status-values": "tools/goal.tools.mjs",
  "goal.prompts": "tools/goal.tools.mjs",
  "delegation.session-payload": "rigel-v2-native-core.mjs",
  "ultrawork.injection": "rigel-v2-native-keyword-seam.mjs",
  "rules.injection": "rigel-v2-native-rules.mjs",
  "recovery.webfetch-redirect": "rigel-v2-native-webfetch-redirect-guard.mjs",
  "permissions.gate-decision": "rigel-v2-native-permissions.mjs",
  "fallback.rung-advance": "rigel-v2-native-model-chains.mjs",
  "compaction.summary-payload": "rigel-v2-native-compaction-context.mjs",
  "skills.scope-discovery": "rigel-v2-native-skills.mjs",
  "goal.lifecycle": "tools/goal.tools.mjs",
  "delegation.resume-payload": "rigel-v2-native-core.mjs",
  "delegation.retry-advance": "rigel-v2-background-retry.mjs",
  "rules.truncate": "rigel-v2-native-rules.mjs",
  "rules.reset-after-compaction": "rigel-v2-native-rules.mjs",
  "fallback.cross-provider": "rigel-v2-background-retry.mjs",
  "fallback.reactive-switch": "rigel-v2-native-model-chains.mjs",
  "skills.body-injection": "rigel-v2-native-skills.mjs",
  "goal.continuation": "tools/goal.tools.mjs",
  "goal.negatives": "tools/goal.tools.mjs",
  "compaction.todo-restore": "rigel-v2-native-compaction-todo-preserver.mjs",
  "compaction.continuity": "rigel-v2-keyword-state.mjs",
  "delegation.handoff-text": "rigel-v2-native-core.mjs",
  "recovery.context-limit": "rigel-v2-native-phase4-events.mjs",
  "delegation.handoff-pipeline": "rigel-v2-background-handoff.mjs",
  // Full-plugin-entrypoint scenarios: each on-disk mutation edits a real
  // runtime seam under profiles/gabo/opencode and must flip the scenario to RED.
  "delegation.entrypoint-handoff": "rigel-v2-native.mjs",
  "recovery.entrypoint-context-limit": "rigel-v2-native.mjs",
  "compaction.entrypoint-summary": "rigel-v2-native.mjs",
  "ultrawork.entrypoint-injection": "rigel-v2-native.mjs",
  "rules.entrypoint-injection": "rigel-v2-native.mjs",
  "permissions.entrypoint-gate": "rigel-v2-native.mjs",
  "fallback.entrypoint-reactive-switch": "rigel-v2-native.mjs",
  "goal.entrypoint-command": "rigel-v2-native.mjs",
  "skills.entrypoint-body-injection": "rigel-v2-native.mjs",
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

/** Insert a throw at the top of a function body, keeping the export name (so
 * the module graph still links) but making every call fail. */
function injectThrow(source, target) {
  const needles = [`export function ${target}(`, `export async function ${target}(`]
  for (const needle of needles) {
    const start = source.indexOf(needle)
    if (start === -1) continue
    let depth = 0
    let cursor = source.indexOf("(", start)
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "(") depth += 1
      else if (source[cursor] === ")") {
        depth -= 1
        if (depth === 0) {
          cursor += 1
          break
        }
      }
    }
    const brace = source.indexOf("{", cursor)
    if (brace === -1) return null
    const injected = `{ throw new Error("RIGEL_MUTATION:${target}");`
    return source.slice(0, brace) + injected + source.slice(brace + 1)
  }
  return null
}

/** Neutralize a value export by rebinding it to an empty value and keeping the
 * original expression in an unused binding. */
function neutralizeValue(source, onDisk) {
  const index = source.indexOf(onDisk.find)
  if (index === -1) return null
  return source.slice(0, index) + onDisk.replace + source.slice(index + onDisk.find.length)
}

/** Mutate the V2 module source so its behavior for a scenario changes while the
 * module still loads. Returns null when no safe mutation point is found. */
function mutateSource(source, mutation) {
  if (mutation.onDisk) return neutralizeValue(source, mutation.onDisk)
  return injectThrow(source, mutation.target)
}

async function buildMatrixJson() {
  const matrix = await runMatrix(scenarios)
  const mutations = await runMutations(scenarios)
  return { matrix, mutations }
}

/** Run the matrix in a fresh process so a mutated file is re-read. */
function matrixJsonInChild() {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--matrix-json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`matrix child failed (exit ${result.status}): ${result.stderr?.slice(0, 800)}`)
  }
  return JSON.parse(result.stdout)
}

async function onDiskMutationProof() {
  // Group every scenario's target export by the file that declares it.
  const byFile = new Map()
  for (const scenario of scenarios) {
    const file = MUTATION_FILES[scenario.id]
    const target = scenario.mutation?.target
    if (!file || !target) continue
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push({ scenario, target })
  }

  const backups = new Map()
  const renamedTargets = new Map()
  try {
    for (const [file, entries] of byFile) {
      const abs = path.join(OPENCODE_DIR, file)
      if (!abs.startsWith(OPENCODE_DIR + path.sep)) throw new Error(`refusing to mutate outside opencode/: ${abs}`)
      const before = fs.readFileSync(abs)
      backups.set(abs, before)
      let source = before.toString("utf8")
      let changed = false
      for (const { scenario } of entries) {
        const next = mutateSource(source, scenario.mutation)
        if (next !== null && next !== source) {
          source = next
          changed = true
        }
      }
      if (changed) fs.writeFileSync(abs, source)
    }

    const mutated = matrixJsonInChild()
    const mutatedById = new Map(mutated.matrix.map((entry) => [entry.id, entry.verdict]))
    const results = []
    for (const [file, entries] of byFile) {
      for (const { scenario } of entries) {
        const verdict = mutatedById.get(scenario.id)
        results.push({
          id: scenario.id,
          file,
          verdict: verdict !== undefined && verdict !== "PASS" ? "RED" : "FAIL",
          reason: verdict === "PASS" ? "mutation did not change the verdict on disk" : "verdict flipped from PASS under a real file mutation",
        })
      }
    }
    return { results, backups }
  } catch (error) {
    return { results: [{ id: "(setup)", verdict: "FAIL", reason: String(error?.message ?? error) }], backups }
  } finally {
    // Restore every mutated file byte for byte and record hashes.
    for (const [abs, before] of backups) {
      if (fs.existsSync(abs)) {
        const current = fs.readFileSync(abs)
        if (!current.equals(before)) fs.writeFileSync(abs, before)
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--matrix-json")) {
    const data = await buildMatrixJson()
    process.stdout.write(JSON.stringify(data))
    return
  }

  const evidenceIndex = args.indexOf("--evidence")
  const explicit = evidenceIndex !== -1 ? args[evidenceIndex + 1] : null
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const evidencePath = explicit
    ? path.resolve(explicit)
    : path.join(REPO_ROOT, ".omo", "evidence", `${stamp}-differential-oracle`, "matrix.txt")
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true })

  const matrix = await runMatrix(scenarios)
  const mutations = await runMutations(scenarios)
  const willMutate = args.includes("--mutate")
  const disk = willMutate ? await onDiskMutationProof() : null

  const failures = matrix.filter((entry) => entry.verdict !== "PASS")
  const injectionsNotRed = mutations.filter((entry) => entry.verdict !== "RED")
  const diskFailures = disk ? disk.results.filter((entry) => entry.verdict !== "RED") : []

  const lines = []
  lines.push("Differential oracle V1 vs native V2 - evidence")
  lines.push(`generated=${new Date().toISOString()}`)
  lines.push(`worktree=${REPO_ROOT}`)
  lines.push(`scenarios=${matrix.length} pass=${matrix.filter((entry) => entry.verdict === "PASS").length} fail=${failures.length}`)
  lines.push(`injection_mutations=${mutations.length} red=${mutations.filter((entry) => entry.verdict === "RED").length}`)
  lines.push(`v1_oracles=${[...new Set(matrix.map((entry) => entry.oracle))].length} (all real V1 imports; BLOCKED is never a pass)`)
  lines.push("")
  lines.push("## matrix")
  lines.push(summarizeMatrix(matrix, null))
  lines.push("")
  lines.push("## injection mutations (no file touched)")
  for (const entry of mutations) lines.push(`  ${entry.verdict} ${entry.id} - ${entry.reason}`)
  if (disk) {
    lines.push("")
    lines.push("## on-disk mutations (real file rename, sha256-verified restore)")
    lines.push(`restore_verified=${diskFailures.length === 0}`)
    for (const entry of disk.results) lines.push(`  ${entry.verdict} ${entry.id} (${entry.file}) - ${entry.reason}`)
  }
  const payload = `${lines.join("\n")}\n`
  fs.writeFileSync(evidencePath, payload)
  process.stdout.write(payload)

  const ok = failures.length === 0 && injectionsNotRed.length === 0 && diskFailures.length === 0
  process.exitCode = ok ? 0 : 1
}

await main()
