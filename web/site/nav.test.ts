import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Drives the real `assets/catalog.js` nav wiring against a minimal fake DOM: the toggle opens the
// SAME nav, the hamburger/close state is carried by aria-expanded, and the menu closes on a link
// pick, Escape or an outside click. No jsdom, no real timers.
const CATALOG_SOURCE = readFileSync(new URL("./assets/catalog.js", import.meta.url), "utf8")

class FakeClassList {
  private readonly names = new Set<string>()
  add(...values: string[]): void {
    for (const value of values) this.names.add(value)
  }
  remove(...values: string[]): void {
    for (const value of values) this.names.delete(value)
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force === undefined ? !this.names.has(name) : force
    if (on) this.names.add(name)
    else this.names.delete(name)
    return on
  }
  contains(name: string): boolean {
    return this.names.has(name)
  }
}

interface NavFixture {
  nav: { classList: FakeClassList }
  toggle: { getAttribute(name: string): string | null }
  open(): void
  clickToggle(): void
  clickLink(): void
  clickOutside(): void
  escape(): void
}

function createNavFixture(): NavFixture {
  const loadHandlers: (() => void)[] = []
  const keyHandlers: ((event: { key: string }) => void)[] = []
  const clickHandlers: ((event: { target: unknown }) => void)[] = []
  const navLink = { tagName: "A", closest: (selector: string): unknown => (selector === "a" ? navLink : null) }
  const nav = {
    classList: new FakeClassList(),
    listeners: [] as ((event: { target: unknown }) => void)[],
    addEventListener(type: string, handler: (event: { target: unknown }) => void): void {
      if (type === "click") this.listeners.push(handler)
    },
    contains(node: unknown): boolean {
      return node === nav || node === navLink
    },
    fire(target: unknown): void {
      for (const handler of [...this.listeners]) handler({ target })
    },
  }
  const toggle = {
    attributes: new Map<string, string>(),
    listeners: [] as (() => void)[],
    addEventListener(type: string, handler: () => void): void {
      if (type === "click") this.listeners.push(handler)
    },
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, String(value))
    },
    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null
    },
    contains(node: unknown): boolean {
      return node === toggle
    },
    closest(): null {
      return null
    },
    focus(): void {},
    fire(): void {
      for (const handler of [...this.listeners]) handler()
    },
  }
  toggle.setAttribute("aria-expanded", "false")
  const documentStub = {
    body: {},
    addEventListener(type: string, handler: unknown): void {
      if (type === "keydown") keyHandlers.push(handler as (event: { key: string }) => void)
      if (type === "click") clickHandlers.push(handler as (event: { target: unknown }) => void)
    },
    getElementById(id: string): unknown {
      return id === "site-nav" ? nav : null
    },
    querySelector(selector: string): unknown {
      return selector === ".nav-toggle" ? toggle : null
    },
    createElement(tag: string): unknown {
      return { tagName: tag.toUpperCase(), style: {}, setAttribute: () => {}, select: () => {}, remove: () => {}, appendChild: () => {} }
    },
    execCommand(): boolean {
      return true
    },
  }
  const windowStub = {
    location: { hash: "" },
    addEventListener(type: string, handler: () => void): void {
      if (type === "DOMContentLoaded") loadHandlers.push(handler)
    },
    setTimeout(): number {
      return 0
    },
    clearTimeout(): void {},
  }
  const run = new Function("window", "document", "navigator", CATALOG_SOURCE)
  run(windowStub, documentStub, {})
  return {
    nav,
    toggle,
    open(): void {
      for (const handler of [...loadHandlers]) handler()
    },
    clickToggle(): void {
      toggle.fire()
      for (const handler of [...clickHandlers]) handler({ target: toggle })
    },
    clickLink(): void {
      nav.fire(navLink)
      for (const handler of [...clickHandlers]) handler({ target: navLink })
    },
    clickOutside(): void {
      for (const handler of [...clickHandlers]) handler({ target: { outside: true, closest: () => null } })
    },
    escape(): void {
      for (const handler of [...keyHandlers]) handler({ key: "Escape" })
    },
  }
}

describe("#given the mobile nav #when the toggle is pressed #then it opens and closes with aria-expanded in step", () => {
  test("#given a closed menu #when the toggle is pressed twice #then it opens then closes", () => {
    // given
    const fixture = createNavFixture()
    fixture.open()
    // when
    fixture.clickToggle()
    // then
    expect([fixture.nav.classList.contains("is-open"), fixture.toggle.getAttribute("aria-expanded")]).toEqual([true, "true"])
    // when
    fixture.clickToggle()
    // then
    expect([fixture.nav.classList.contains("is-open"), fixture.toggle.getAttribute("aria-expanded")]).toEqual([false, "false"])
  })
})

describe("#given an open mobile nav #when it is dismissed #then a link pick, Escape and an outside click each close it", () => {
  test("#given an open menu #when a link is chosen #then the menu closes", () => {
    // given
    const fixture = createNavFixture()
    fixture.open()
    fixture.clickToggle()
    // when
    fixture.clickLink()
    // then
    expect(fixture.nav.classList.contains("is-open")).toBe(false)
  })

  test("#given an open menu #when Escape is pressed #then the menu closes", () => {
    // given
    const fixture = createNavFixture()
    fixture.open()
    fixture.clickToggle()
    // when
    fixture.escape()
    // then
    expect(fixture.nav.classList.contains("is-open")).toBe(false)
  })

  test("#given an open menu #when the page outside is clicked #then the menu closes", () => {
    // given
    const fixture = createNavFixture()
    fixture.open()
    fixture.clickToggle()
    // when
    fixture.clickOutside()
    // then
    expect(fixture.nav.classList.contains("is-open")).toBe(false)
  })

  test("#given an open menu #when the toggle itself is clicked #then it does not double-close (stays open)", () => {
    // given
    const fixture = createNavFixture()
    fixture.open()
    // when
    fixture.clickToggle()
    // then
    expect(fixture.nav.classList.contains("is-open")).toBe(true)
  })
})
