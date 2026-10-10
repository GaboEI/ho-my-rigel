import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

// Pipeline contract: the publication workflow must actually EXECUTE the WCAG contrast gate and
// the i18n/render gate, not only source.test.ts. A contrast token that breaks readability has to
// fail a pull request, so the workflow runs the full `web/` suite as a blocking step. This test
// guards that wiring itself, because a green local suite proves nothing if CI never runs it.

const WORKFLOW = readFileSync(new URL("../../.github/workflows/web-public.yml", import.meta.url), "utf8")

describe("#given the web publication workflow #when its test gate is inspected #then the contrast and render suites run and block", () => {
  test("#given the workflow #when the trigger is read #then it runs on pull requests to v2-mirror", () => {
    // given / when / then
    expect(/\bpull_request:/.test(WORKFLOW)).toBe(true)
    expect(/branches:\s*\[v2-mirror\]/.test(WORKFLOW)).toBe(true)
  })

  test("#given the CI steps #when they are read #then the full web suite runs (contrast + render + source), not only source.test.ts", () => {
    // given / when / then
    expect(/run:\s*bun test web\/\s*$/m.test(WORKFLOW)).toBe(true)
  })

  test("#given the gates on disk #when their existence is checked #then the suite path covers them", () => {
    // given / when / then
    expect(existsSync(new URL("./contrast.test.ts", import.meta.url))).toBe(true)
    expect(existsSync(new URL("./render.test.ts", import.meta.url))).toBe(true)
    expect(existsSync(new URL("../data/source.test.ts", import.meta.url))).toBe(true)
  })

  test("#given the workflow #when blocking semantics are checked #then no step disables failure", () => {
    // given / when / then
    expect(/continue-on-error\s*:\s*true/.test(WORKFLOW)).toBe(false)
  })
})
