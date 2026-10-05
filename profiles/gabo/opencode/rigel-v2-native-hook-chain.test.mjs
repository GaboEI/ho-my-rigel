import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { runOrderedRules } from "./rigel-v2-native-hook-chain.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"
import { loadV1Oracle, V1_ORACLE_IDS } from "./test-support/v1-oracle.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-hook-chain-"))
  temporary.push(dir)
  return dir
}

const HOOK_CHAIN_SOURCE = fileURLToPath(new URL("./rigel-v2-native-hook-chain.mjs", import.meta.url))

describe("Rigel native V2 ordered hook chain", () => {
  test("#given rules in a declared order #when runOrderedRules runs #then each rule observes the ones before it", async () => {
    const calls = []
    const rules = [
      { name: "first", run: async (input) => { calls.push(`first:${input}`) } },
      { name: "second", run: (input) => { calls.push(`second:${input}`) } },
      { name: "third", run: (input) => { calls.push(`third:${input}`) } },
    ]

    const { failures, executed } = await runOrderedRules(rules, "payload")

    expect(calls).toEqual(["first:payload", "second:payload", "third:payload"])
    expect(executed).toEqual(["first", "second", "third"])
    expect(failures).toEqual([])
  })

  test("#given a throwing middle rule #when runOrderedRules runs #then downstream rules execute and the failure is recorded", async () => {
    const calls = []
    const boom = new Error("kaput")
    const rules = [
      { name: "before", run: () => { calls.push("before") } },
      { name: "explode", run: () => { throw boom } },
      { name: "after", run: () => { calls.push("after") } },
    ]

    const { failures, executed } = await runOrderedRules(rules, null)

    expect(calls).toEqual(["before", "after"])
    expect(executed).toEqual(["before", "after"])
    expect(failures).toHaveLength(1)
    expect(failures[0].name).toBe("explode")
    expect(failures[0].error).toBe(boom)
  })

  test("#given multiple throwing rules #when runOrderedRules runs #then every failure is surfaced and onError observes each", async () => {
    const observed = []
    const rules = [
      { name: "one", run: () => { throw new Error("one") } },
      { name: "ok", run: () => {} },
      { name: "two", run: () => { throw new Error("two") } },
    ]

    const { failures, executed } = await runOrderedRules(rules, null, {
      onError: (failure) => observed.push(failure.name),
    })

    expect(failures.map((failure) => failure.name)).toEqual(["one", "two"])
    expect(observed).toEqual(["one", "two"])
    expect(executed).toEqual(["ok"])
  })

  test("#given a rule without a runnable function #when runOrderedRules runs #then it is recorded and the chain continues", async () => {
    const calls = []

    const { failures, executed } = await runOrderedRules([
      { name: "broken" },
      { name: "after", run: () => { calls.push("after") } },
    ], null)

    expect(failures).toHaveLength(1)
    expect(failures[0].name).toBe("broken")
    expect(failures[0].error).toBeInstanceOf(TypeError)
    expect(calls).toEqual(["after"])
    expect(executed).toEqual(["after"])
  })

  test("#given a bare named function rule #when runOrderedRules runs #then its function name labels the failure", async () => {
    function explosion() { throw new Error("x") }

    const { failures } = await runOrderedRules([explosion], null)

    expect(failures).toHaveLength(1)
    expect(failures[0].name).toBe("explosion")
  })

  test("#given a non-array rules value #when runOrderedRules is called #then it throws a TypeError", async () => {
    await expect(runOrderedRules(null, null)).rejects.toThrow(TypeError)
  })
})

describe("Rigel native V2 named-RED mutation harness", () => {
  test("#given a file and a named contract #when runMutation applies a mutation #then the contract goes RED and the file is restored byte-identically", async () => {
    const dir = tempDir()
    const file = path.join(dir, "sample.mjs")
    fs.writeFileSync(file, "export const value = 1\n")
    const before = fs.readFileSync(file)

    const receipt = await runMutation({
      file,
      mutate: (source) => source.replace("value = 1", "value = 2"),
      contract: {
        name: "sample value stays 1",
        run: async ({ load }) => {
          const module = await load()
          if (module.value !== 1) throw new Error(`expected value 1, got ${module.value}`)
        },
      },
    })

    expect(receipt.contract).toBe("sample value stays 1")
    expect(receipt.red).toBe(true)
    expect(receipt.redError).toContain("expected value 1")
    expect(receipt.restored).toBe(true)
    expect(receipt.beforeHash).toBe(receipt.afterHash)
    expect(fs.readFileSync(file).equals(before)).toBe(true)
  })

  test("#given the real hook chain #when its failure record is mutated #then the named contract turns RED and the source is byte-identical after restore", async () => {
    const dir = tempDir()
    const target = path.join(dir, "hook-chain.mjs")
    fs.copyFileSync(HOOK_CHAIN_SOURCE, target)
    const sourceHash = createHash("sha256").update(fs.readFileSync(target)).digest("hex")

    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace("const failure = { name, error }", "const failure = { name, error: null }"),
      contract: {
        name: "ordered chain records the thrown Error on an isolated failure",
        run: async ({ load }) => {
          const module = await load()
          const { failures } = await module.runOrderedRules(
            [{ name: "explode", run: () => { throw new Error("kaput") } }],
            null,
          )
          if (!(failures[0]?.error instanceof Error)) {
            throw new Error("expected the isolated failure to carry the thrown Error")
          }
        },
      },
    })

    expect(receipt.contract).toBe("ordered chain records the thrown Error on an isolated failure")
    expect(receipt.red).toBe(true)
    expect(receipt.redError).toContain("isolated failure to carry the thrown Error")
    expect(receipt.beforeHash).toBe(receipt.afterHash)
    const restoredHash = createHash("sha256").update(fs.readFileSync(target)).digest("hex")
    expect(restoredHash).toBe(sourceHash)
    const trackedHash = createHash("sha256").update(fs.readFileSync(HOOK_CHAIN_SOURCE)).digest("hex")
    expect(trackedHash).toBe(sourceHash)
  })
})

describe("Rigel native V2 differential oracle", () => {
  test("#given the repo workspace #when each oracle id loads #then the real V1 core resolves with its required exports", async () => {
    for (const id of V1_ORACLE_IDS) {
      const oracle = await loadV1Oracle(id)
      expect(oracle.source).toBe("v1")
      expect(oracle.degraded).toBe(false)
      expect(oracle.module).not.toBeNull()
    }
  })

  test("#given an unresolvable import #when loadV1Oracle runs #then it degrades to the documented fallback instead of a copied mirror", async () => {
    const oracle = await loadV1Oracle("delegate-core.retry-patterns", {
      importModule: async () => { throw new Error("hermetic failure") },
    })

    expect(oracle.source).toBe("fallback")
    expect(oracle.degraded).toBe(true)
    expect(oracle.module).toBeNull()
    expect(oracle.reason).toContain("hermetic failure")
  })

  test("#given an unknown oracle id #when loadV1Oracle runs #then it rejects", async () => {
    await expect(loadV1Oracle("does-not-exist")).rejects.toThrow("unknown oracle id")
  })
})
