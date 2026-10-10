import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Drives the real `assets/catalog.js` (read from disk) against a minimal fake DOM: no
// jsdom, no happy-dom and no real timers. `window.setTimeout` / `window.clearTimeout` are
// captured, so the recovery path is proven by invoking the recorded callback, never by
// sleeping. Clicks go through the same `event.target.closest(".copy")` delegation the
// browser uses, including a click that lands on the icon child.
const CATALOG_SOURCE = readFileSync(new URL("./assets/catalog.js", import.meta.url), "utf8")

class FakeClassList {
  private readonly names = new Set<string>()

  add(...names: string[]): void {
    for (const name of names) this.names.add(name)
  }

  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name)
  }

  contains(name: string): boolean {
    return this.names.has(name)
  }
}

class FakeElement {
  readonly tagName: string
  readonly classList = new FakeClassList()
  readonly style: Record<string, string> = {}
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  parent: FakeElement | null = null
  textContent = ""

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    child.parent = this
    return child
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this)
      if (index >= 0) this.parent.children.splice(index, 1)
    }
    this.parent = null
  }

  select(): void {}

  matches(selector: string): boolean {
    return selector.startsWith(".") ? this.classList.contains(selector.slice(1)) : this.tagName === selector.toUpperCase()
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this
    while (node) {
      if (node.matches(selector)) return node
      node = node.parent
    }
    return null
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
}

type WriteOutcome = "resolve" | "reject"

interface TimerRecord {
  fn: () => void
  ms: number
  cleared: boolean
}

interface Fixture {
  document: { body: FakeElement }
  timers: TimerRecord[]
  writeTextCalls: string[]
  setOutcome(outcome: WriteOutcome): void
  open(): void
  press(target: FakeElement): void
}

function createFixture(options: { clipboard?: boolean; execCommand?: boolean } = {}): Fixture {
  let outcome: WriteOutcome = "resolve"
  const clickHandlers: ((event: { target: FakeElement }) => void)[] = []
  const loadHandlers: (() => void)[] = []
  const timers: TimerRecord[] = []
  const writeTextCalls: string[] = []
  const body = new FakeElement("body")

  const documentStub = {
    body,
    addEventListener(type: string, handler: (event: { target: FakeElement }) => void): void {
      if (type === "click") clickHandlers.push(handler)
    },
    createElement(tag: string): FakeElement {
      return new FakeElement(tag)
    },
    getElementById(_id: string): null {
      return null
    },
    querySelector(_selector: string): null {
      return null
    },
    execCommand(_command: string): boolean {
      return options.execCommand ?? true
    },
  }

  const windowStub = {
    location: { hash: "" },
    addEventListener(type: string, handler: () => void): void {
      if (type === "DOMContentLoaded") loadHandlers.push(handler)
    },
    setTimeout(fn: () => void, ms: number): number {
      timers.push({ fn, ms, cleared: false })
      return timers.length
    },
    clearTimeout(id: number): void {
      const timer = timers[id - 1]
      if (timer) timer.cleared = true
    },
  }

  const navigatorStub: { clipboard?: { writeText(text: string): Promise<void> } } = {}
  if (options.clipboard ?? true) {
    navigatorStub.clipboard = {
      writeText(text: string): Promise<void> {
        writeTextCalls.push(text)
        return outcome === "reject" ? Promise.reject(new Error("clipboard denied")) : Promise.resolve()
      },
    }
  }

  const run = new Function("window", "document", "navigator", CATALOG_SOURCE)
  run(windowStub, documentStub, navigatorStub)

  return {
    document: documentStub,
    timers,
    writeTextCalls,
    setOutcome(next: WriteOutcome): void {
      outcome = next
    },
    open(): void {
      for (const handler of [...loadHandlers]) handler()
    },
    press(target: FakeElement): void {
      for (const handler of [...clickHandlers]) handler({ target })
    },
  }
}

// Mirrors the copyableBlock markup the renderer emits: one `.cmd` row, the icon-only
// button, and the live status region. The icon is the click target, so closest() walks up
// exactly as it does in a browser.
function copyRow(): { row: FakeElement; button: FakeElement; status: FakeElement; icon: FakeElement } {
  const row = new FakeElement("div")
  row.classList.add("cmd")
  const code = new FakeElement("pre")
  code.classList.add("cmd__code")
  const button = new FakeElement("button")
  button.classList.add("copy")
  button.setAttribute("data-copy", "~/.omo/omo.jsonc")
  button.setAttribute("data-copied", "Copiado")
  button.setAttribute("data-error", "Error al copiar")
  const status = new FakeElement("span")
  status.classList.add("cmd__status", "visually-hidden")
  status.setAttribute("role", "status")
  const icon = button.appendChild(new FakeElement("svg"))
  row.appendChild(code)
  row.appendChild(button)
  row.appendChild(status)
  return { row, button, status, icon }
}

// The script settles through a promise chain (writeText -> then onDone/onError): a fixed
// number of microtask hops is deterministic and needs no timer.
async function settle(): Promise<void> {
  for (let hop = 0; hop < 8; hop += 1) await Promise.resolve()
}

describe("#given the copy control #when the clipboard write resolves #then the exact text is copied and success is integrated", () => {
  test("#given a resolvable clipboard #when the icon is clicked #then writeText receives the data-copy text once and button, row and live region show success", async () => {
    // given
    const fixture = createFixture()
    fixture.open()
    const { row, button, status, icon } = copyRow()
    // when
    fixture.press(icon)
    await settle()
    // then
    expect(fixture.writeTextCalls).toEqual(["~/.omo/omo.jsonc"])
    expect([button.classList.contains("is-done"), row.classList.contains("is-done")]).toEqual([true, true])
    expect([button.classList.contains("is-error"), row.classList.contains("is-error")]).toEqual([false, false])
    expect(status.textContent).toBe("Copiado")
    expect(fixture.timers.map((timer) => timer.ms)).toEqual([2000])
  })
})

describe("#given the copy control #when the clipboard write rejects #then the failure is visible on the button and the row", () => {
  test("#given a rejecting clipboard #when the icon is clicked #then button and row carry is-error and the live region shows the data-error message", async () => {
    // given
    const fixture = createFixture()
    fixture.setOutcome("reject")
    fixture.open()
    const { row, button, status, icon } = copyRow()
    // when
    fixture.press(icon)
    await settle()
    // then
    expect(fixture.writeTextCalls).toEqual(["~/.omo/omo.jsonc"])
    expect([button.classList.contains("is-error"), row.classList.contains("is-error")]).toEqual([true, true])
    expect([button.classList.contains("is-done"), row.classList.contains("is-done")]).toEqual([false, false])
    expect(status.textContent).toBe("Error al copiar")
    expect(fixture.timers.map((timer) => timer.ms)).toEqual([3000])
  })
})

describe("#given a settled copy #when the recorded reset fires #then button, row and live region clear", () => {
  for (const scenario of [
    { name: "success", outcome: "resolve" as WriteOutcome, message: "Copiado", ms: 2000 },
    { name: "failure", outcome: "reject" as WriteOutcome, message: "Error al copiar", ms: 3000 },
  ]) {
    test(`#given a ${scenario.name} #when the ${scenario.ms}ms reset fires #then no state or text remains`, async () => {
      // given
      const fixture = createFixture()
      fixture.setOutcome(scenario.outcome)
      fixture.open()
      const { row, button, status, icon } = copyRow()
      fixture.press(icon)
      await settle()
      expect(status.textContent).toBe(scenario.message)
      const reset = fixture.timers.at(-1)
      expect(reset?.ms).toBe(scenario.ms)
      // when
      reset?.fn()
      // then
      expect([button.classList.contains("is-done"), button.classList.contains("is-error")]).toEqual([false, false])
      expect([row.classList.contains("is-done"), row.classList.contains("is-error")]).toEqual([false, false])
      expect(status.textContent).toBe("")
    })
  }
})

describe("#given a browser without the async clipboard API #when the execCommand fallback fails #then the failure is reported", () => {
  test("#given no clipboard.writeText #when execCommand returns false #then the error state is applied and the temporary textarea is removed", async () => {
    // given
    const fixture = createFixture({ clipboard: false, execCommand: false })
    fixture.open()
    const { row, button, status, icon } = copyRow()
    expect(fixture.document.body.children.length).toBe(0)
    // when
    fixture.press(icon)
    await settle()
    // then
    expect(fixture.writeTextCalls).toEqual([])
    expect([button.classList.contains("is-error"), row.classList.contains("is-error")]).toEqual([true, true])
    expect(status.textContent).toBe("Error al copiar")
    expect(fixture.document.body.children.length).toBe(0)
  })
})

describe("#given a failed copy #when a later copy succeeds #then success replaces the error and cancels the pending reset", () => {
  test("#given an error state #when the next write resolves #then only is-done remains and the failure timer is cancelled", async () => {
    // given
    const fixture = createFixture()
    fixture.open()
    const { row, button, status, icon } = copyRow()
    fixture.setOutcome("reject")
    fixture.press(icon)
    await settle()
    expect(button.classList.contains("is-error")).toBe(true)
    const failureTimer = fixture.timers.at(-1)
    // when
    fixture.setOutcome("resolve")
    fixture.press(icon)
    await settle()
    // then
    expect([button.classList.contains("is-done"), button.classList.contains("is-error")]).toEqual([true, false])
    expect([row.classList.contains("is-done"), row.classList.contains("is-error")]).toEqual([true, false])
    expect(status.textContent).toBe("Copiado")
    expect(failureTimer?.cleared).toBe(true)
    expect(fixture.timers.map((timer) => timer.ms)).toEqual([3000, 2000])
  })
})
