/**
 * Differential oracle harness.
 *
 * Runs every registered scenario through the REAL V1 owner (hermetic import,
 * no process, no state mutation) and the native V2 mirror, compares the
 * normalized observables under the scenario's declared tolerance, and can
 * re-run each scenario against a mutated V2 export to prove the comparison is
 * live (a mutation that changes nothing is itself a failure).
 */

import { loadV1Oracle } from "../test-support/v1-oracle.mjs"
import { compare, normalize } from "./normalize.mjs"

function inputName(input, index) {
  return input && typeof input.name === "string" ? input.name : `row-${index}`
}

/**
 * Resolve the V1 side of a scenario. Either a single owner via the oracle
 * registry (`oracle`), or an integration module set loaded directly (`loadV1`),
 * which is how the end-to-end scenarios obtain the real factory/handler.
 * Returns `{ module }` or `{ blocked }`.
 */
async function loadV1Side(scenario) {
  if (scenario.oracle) {
    const oracle = await loadV1Oracle(scenario.oracle)
    if (oracle.source !== "v1") {
      return { blocked: `V1 oracle "${scenario.oracle}" did not load: ${oracle.reason}` }
    }
    return { module: oracle.module, label: scenario.oracle }
  }
  if (typeof scenario.loadV1 === "function") {
    try {
      return { module: await scenario.loadV1(), label: `integration:${scenario.id}` }
    } catch (error) {
      return { blocked: `integration V1 load failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { blocked: `scenario "${scenario.id}" declares neither oracle nor loadV1` }
}

function observableType(scenario) {
  return scenario.observableType ?? "helper"
}

/**
 * Run a single scenario. Returns a verdict object; a V1 owner that does not
 * load is `BLOCKED`, never a pass, because no degraded oracle is accepted.
 */
export async function runScenario(scenario) {
  const v1 = await loadV1Side(scenario)
  if (v1.blocked) {
    return {
      id: scenario.id,
      family: scenario.family,
      oracle: scenario.oracle ?? `integration:${scenario.id}`,
      observableType: observableType(scenario),
      verdict: "BLOCKED",
      reason: v1.blocked,
      rows: [],
    }
  }
  const v2 = await scenario.loadV2()
  const corpus = typeof scenario.corpus === "function" ? scenario.corpus(v1.module) : scenario.corpus
  const rows = []
  for (const [index, input] of corpus.entries()) {
    try {
      const expected = normalize(await scenario.observeV1(v1.module, input))
      const actual = normalize(await scenario.observeV2(v2, input, v1.module))
      const cmp = compare(expected, actual, scenario.tolerance)
      rows.push({
        name: inputName(input, index),
        pass: cmp.ok,
        kind: cmp.kind,
        detail: cmp.detail,
        expected,
        actual,
      })
    } catch (error) {
      rows.push({
        name: inputName(input, index),
        pass: false,
        kind: "error",
        detail: `observation threw: ${error instanceof Error ? error.message : String(error)}`,
        expected: null,
        actual: null,
      })
    }
  }
  const passed = rows.length > 0 && rows.every((row) => row.pass)
  return {
    id: scenario.id,
    family: scenario.family,
    oracle: v1.label,
    observableType: observableType(scenario),
    verdict: passed ? "PASS" : "FAIL",
    reason: passed ? null : "one or more corpus rows diverged",
    rows,
  }
}

/** Run every scenario and return the verdict list (the scenario matrix). */
export async function runMatrix(scenarios) {
  const results = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario))
  }
  return results
}

/**
 * For each scenario with a declared mutation, substitute the target V2 export
 * with a perturbed version (no file is touched) and assert at least one corpus
 * row flips to FAIL. A mutation that does not flip a row means the comparison
 * is not actually exercising the behavior.
 */
export async function runMutations(scenarios) {
  const results = []
  for (const scenario of scenarios) {
    if (!scenario.mutation) {
      results.push({ id: scenario.id, verdict: "MISSING", reason: "no mutation declared" })
      continue
    }
    const v1 = await loadV1Side(scenario)
    if (v1.blocked) {
      results.push({ id: scenario.id, verdict: "BLOCKED", reason: v1.blocked })
      continue
    }
    const v2 = await scenario.loadV2()
    const real = v2[scenario.mutation.target]
    if (real === undefined) {
      results.push({ id: scenario.id, verdict: "FAIL", reason: `mutation target "${scenario.mutation.target}" is not exported by the V2 mirror` })
      continue
    }
    const patched = { ...v2, [scenario.mutation.target]: scenario.mutation.perturb(real) }
    const corpus = typeof scenario.corpus === "function" ? scenario.corpus(v1.module) : scenario.corpus
    let flipped = false
    for (const input of corpus) {
      try {
        const expected = normalize(await scenario.observeV1(v1.module, input))
        const actual = normalize(await scenario.observeV2(patched, input, v1.module))
        if (!compare(expected, actual, scenario.tolerance).ok) {
          flipped = true
          break
        }
      } catch {
        flipped = true
        break
      }
    }
    results.push({
      id: scenario.id,
      verdict: flipped ? "RED" : "FAIL",
      reason: flipped
        ? "mutation flipped at least one corpus row to FAIL (comparison is live)"
        : "mutation changed no row; the comparison is not exercising the behavior",
    })
  }
  return results
}

/** Human-readable matrix summary for evidence files. */
export function summarizeMatrix(matrix, mutations) {
  const lines = []
  const byFamily = new Map()
  for (const result of matrix) {
    if (!byFamily.has(result.family)) byFamily.set(result.family, [])
    byFamily.get(result.family).push(result)
  }
  for (const [family, results] of [...byFamily.entries()].sort()) {
    lines.push(`[${family}]`)
    for (const result of results) {
      const failed = result.rows.filter((row) => !row.pass).map((row) => row.name)
      lines.push(`  ${result.verdict.padEnd(7)} [${result.observableType}] ${result.id} (${result.rows.length} rows, oracle=${result.oracle})${failed.length ? ` FAILED: ${failed.join(", ")}` : ""}`)
    }
  }
  if (mutations) {
    lines.push("[mutations]")
    for (const result of mutations) {
      lines.push(`  ${result.verdict.padEnd(7)} ${result.id}${result.reason ? ` - ${result.reason}` : ""}`)
    }
  }
  return lines.join("\n")
}
