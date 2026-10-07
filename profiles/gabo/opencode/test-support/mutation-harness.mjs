/**
 * Named-RED mutation harness for the Rigel native V2 test suites.
 *
 * A mutation test only proves something when it turns a SPECIFIC, NAMED
 * contract red. This harness enforces exactly that:
 *
 *   1. the contract is confirmed GREEN on the original source (a contract that
 *      is already red, or that always throws, proves nothing);
 *   2. the mutation is applied and the SAME contract must now fail (RED);
 *   3. the original bytes are restored and their `sha256` must be identical to
 *      the pre-mutation hash.
 *
 * The restore runs in a `finally`, so it happens even when the RED assertion
 * throws as expected. `runMutation` returns a receipt naming the contract and
 * both hashes for the evidence ledger.
 *
 * ESM module caching means a contract cannot observe a file that was rewritten
 * under an already-imported specifier. The harness therefore passes the
 * contract a `load()` helper: it copies the CURRENT target bytes to a unique
 * sibling file and imports that copy, so every call re-evaluates the mutated
 * source. The copy is removed after the import resolves. A target with relative
 * imports must keep its dependencies next to it, because the copy resolves
 * imports relative to the target's own directory.
 */

import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeContract(contract) {
  if (typeof contract === "function") {
    if (typeof contract.name !== "string" || contract.name.length === 0) {
      throw new Error("runMutation: a bare contract function must be named; pass { name, run }")
    }
    return { name: contract.name, run: contract }
  }
  if (
    !contract
    || typeof contract.run !== "function"
    || typeof contract.name !== "string"
    || contract.name.length === 0
  ) {
    throw new Error("runMutation: contract must be { name, run } (or a named function)")
  }
  return { name: contract.name, run: contract.run }
}

// Process-wide counter so two `runMutation` calls on the SAME file in one
// process never reuse a mutant sibling name. A per-loader counter collided
// across calls (same pid + same sequence), and bun's module cache then returned
// the first call's stale sibling instead of re-reading the second mutation.
let mutantSequence = 0

function createFreshLoader(file) {
  const directory = path.dirname(file)
  const fallbackExtension = path.extname(file)
  return async function load(specifier = file) {
    const absolute = path.isAbsolute(specifier) ? specifier : path.resolve(directory, specifier)
    const extension = path.extname(absolute) || fallbackExtension
    const base = path.basename(absolute, path.extname(absolute))
    const copy = path.join(directory, `.mutant-${base}-${process.pid}-${mutantSequence}${extension}`)
    mutantSequence += 1
    fs.copyFileSync(absolute, copy)
    try {
      return await import(pathToFileURL(copy).href)
    } finally {
      fs.rmSync(copy, { force: true })
    }
  }
}

/**
 * Apply one mutation, prove it turns a named contract RED, and restore the file.
 *
 * @param {object} spec
 * @param {string} spec.file absolute path to the source file to mutate
 * @param {(source: string) => string} spec.mutate transforms the source; must
 *   return different text, otherwise the harness throws
 * @param {{ name: string, run: (context: { load: (specifier?: string) => Promise<object> }) => unknown }} spec.contract
 *   the NAMED contract this mutation must turn red; `run` throws when the
 *   contract is violated
 * @returns {Promise<{ contract: string, beforeHash: string, afterHash: string, red: true, redError: string, restored: true }>}
 */
export async function runMutation({ file, mutate, contract }) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("runMutation: file must be a non-empty path")
  }
  if (typeof mutate !== "function") {
    throw new Error("runMutation: mutate must be a function")
  }
  const named = normalizeContract(contract)
  const before = fs.readFileSync(file)
  const beforeHash = sha256(before)
  const original = before.toString("utf8")
  const load = createFreshLoader(file)

  let baselineError
  try {
    await named.run({ load })
  } catch (error) {
    baselineError = error
  }
  if (baselineError) {
    throw new Error(`runMutation: contract "${named.name}" is already RED before mutation: ${describeError(baselineError)}`)
  }

  const mutated = mutate(original)
  if (typeof mutated !== "string" || mutated === original) {
    throw new Error(`runMutation: mutate must return changed source for contract "${named.name}"`)
  }

  let redError
  try {
    fs.writeFileSync(file, mutated)
    try {
      await named.run({ load })
    } catch (error) {
      redError = error
    }
    if (!redError) {
      throw new Error(`runMutation: contract "${named.name}" stayed GREEN under mutation; it does not guard this behavior`)
    }
  } finally {
    fs.writeFileSync(file, before)
  }

  const afterHash = sha256(fs.readFileSync(file))
  if (afterHash !== beforeHash) {
    throw new Error(`runMutation: restore was not byte-identical for "${named.name}" (${beforeHash} -> ${afterHash})`)
  }

  return {
    contract: named.name,
    beforeHash,
    afterHash,
    red: true,
    redError: describeError(redError),
    restored: true,
  }
}
