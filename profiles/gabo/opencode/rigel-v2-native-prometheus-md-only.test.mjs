import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createNativePrometheusMdOnly,
  isAllowedFile,
  isPrometheusAgent,
  isPrometheusMdBlockedTool,
  PLANNING_CONSULT_WARNING,
  PLANNING_CONTEXT_OPEN,
  PROMETHEUS_WORKFLOW_REMINDER,
} from "./rigel-v2-native-prometheus-md-only.mjs"

const temporary = []
afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true })
})

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-prometheus-md-"))
  temporary.push(root)
  return root
}

function prometheusHook(root) {
  return createNativePrometheusMdOnly({
    directory: root,
    resolveAgent: async ({ sessionID }) => (sessionID ? "Prometheus - Plan Builder" : undefined),
  })
}

function v1BlockMessage(filePath) {
  return (
    `[prometheus-md-only] Prometheus is a planning agent. File operations restricted to .omo/*.md plan files only. ` +
    `Do NOT route this change through a subagent either - delegated implementation is still implementation. ` +
    `Record the intended change as a todo in the plan; implementation starts only when the user runs /ulw-execute. ` +
    `Attempted to modify: ${filePath}.`
  )
}

describe("isAllowedFile", () => {
  test("allows a .omo plan markdown file at the workspace root", () => {
    const root = workspace()
    expect(isAllowedFile(".omo/plans/x.md", root)).toBe(true)
  })

  test("allows a nested .omo markdown file below the workspace root", () => {
    const root = workspace()
    expect(isAllowedFile("sub/.omo/y.md", root)).toBe(true)
  })

  test("rejects a source file outside .omo", () => {
    expect(isAllowedFile("src/x.ts", workspace())).toBe(false)
  })

  test("rejects a non-markdown file inside .omo", () => {
    expect(isAllowedFile(".omo/plans/x.txt", workspace())).toBe(false)
  })

  test("rejects a traversal that escapes the workspace root", () => {
    expect(isAllowedFile("../escape/x.md", workspace())).toBe(false)
  })

  test("rejects an absolute path outside the workspace root", () => {
    const root = workspace()
    const outside = path.join(os.tmpdir(), "rigel-v2-prometheus-outside", "x.md")
    expect(isAllowedFile(outside, root)).toBe(false)
  })

  test("rejects a .omo filename prefix that is not a directory segment", () => {
    expect(isAllowedFile(".omox/y.md", workspace())).toBe(false)
  })
})

describe("isPrometheusAgent", () => {
  test("matches Prometheus variants case-insensitively", () => {
    expect(isPrometheusAgent("Prometheus")).toBe(true)
    expect(isPrometheusAgent("PROMETHEUS")).toBe(true)
    expect(isPrometheusAgent("Prometheus - Plan Builder")).toBe(true)
  })

  test("rejects other agents and undefined", () => {
    expect(isPrometheusAgent("Atlas - Plan Executor")).toBe(false)
    expect(isPrometheusAgent(undefined)).toBe(false)
  })
})

describe("isPrometheusMdBlockedTool", () => {
  test("matches write and edit in any casing", () => {
    expect(isPrometheusMdBlockedTool("write")).toBe(true)
    expect(isPrometheusMdBlockedTool("Write")).toBe(true)
    expect(isPrometheusMdBlockedTool("edit")).toBe(true)
    expect(isPrometheusMdBlockedTool("Edit")).toBe(true)
  })

  test("rejects unrelated tools", () => {
    expect(isPrometheusMdBlockedTool("read")).toBe(false)
    expect(isPrometheusMdBlockedTool("bash")).toBe(false)
  })
})

describe("createNativePrometheusMdOnly", () => {
  test("throws the V1 message for a Prometheus write outside .omo markdown", async () => {
    // given
    const hook = prometheusHook(workspace())
    const event = { tool: "write", sessionID: "ses_prom", args: { filePath: "src/x.ts", content: "x" } }

    // when / then
    await expect(hook.before(event)).rejects.toThrow(v1BlockMessage("src/x.ts"))
  })

  test("allows a Prometheus write of a .omo plan markdown file", async () => {
    // given
    const hook = prometheusHook(workspace())
    const event = { tool: "Write", sessionID: "ses_prom", args: { filePath: ".omo/plans/x.md", content: "plan" }, message: "" }

    // when / then
    await expect(hook.before(event)).resolves.toBeUndefined()
  })

  test("appends the workflow reminder when writing a .omo plan file", async () => {
    // given
    const hook = prometheusHook(workspace())
    const event = { tool: "write", sessionID: "ses_prom", args: { filePath: ".omo/plans/x.md" }, message: "existing" }

    // when
    await hook.before(event)

    // then
    expect(event.message).toBe("existing" + PROMETHEUS_WORKFLOW_REMINDER)
  })

  test("does not throw for a plan write when the event carries no writable message", async () => {
    // given
    const hook = prometheusHook(workspace())
    const event = { tool: "write", sessionID: "ses_prom", args: { filePath: ".omo/plans/x.md" } }

    // when / then
    await expect(hook.before(event)).resolves.toBeUndefined()
  })

  test("prepends the planning warning to a Prometheus task prompt exactly once", async () => {
    // given
    const hook = prometheusHook(workspace())
    const event = { tool: "task", sessionID: "ses_prom", args: { prompt: "investigate" } }

    // when
    await hook.before(event)
    const afterFirst = event.args.prompt
    await hook.before(event)

    // then
    expect(afterFirst).toBe(PLANNING_CONSULT_WARNING + "investigate")
    expect(afterFirst.includes(PLANNING_CONTEXT_OPEN)).toBe(true)
    expect(event.args.prompt).toBe(afterFirst)
    expect(event.args.prompt.split(PLANNING_CONTEXT_OPEN).length - 1).toBe(1)
  })

  test("prepends the planning warning to a rigel_task prompt", async () => {
    // given
    const hook = prometheusHook(workspace())
    const event = { tool: "rigel_task", sessionID: "ses_prom", args: { prompt: "delegate" } }

    // when
    await hook.before(event)

    // then
    expect(event.args.prompt).toBe(PLANNING_CONSULT_WARNING + "delegate")
  })

  test("does not restrict a non-Prometheus agent", async () => {
    // given
    const hook = createNativePrometheusMdOnly({
      directory: workspace(),
      resolveAgent: async () => "Atlas - Plan Executor",
    })
    const event = { tool: "write", sessionID: "ses_atlas", args: { filePath: "src/x.ts", content: "x" } }

    // when / then
    await expect(hook.before(event)).resolves.toBeUndefined()
  })

  test("does not fail when no agent can be resolved", async () => {
    // given
    const hook = createNativePrometheusMdOnly({ directory: workspace(), resolveAgent: async () => undefined })
    const event = { tool: "edit", sessionID: "ses_unknown", args: { path: "src/x.ts" } }

    // when / then
    await expect(hook.before(event)).resolves.toBeUndefined()
  })
})
