import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import { homePage, catalogPage, guidePage, notFoundPage, THEME_INIT, THEME_COPY } from "./lib/render.mjs"
import { loadSource } from "./lib/data.mjs"
import { loadOverlays, localizeSource } from "./lib/i18n.mjs"

// Fail-closed gate for the header theme picker (compact current-mode icon + caret, opening a menu
// with Sistema / Claro / Oscuro). It guards the real contracts: the two Gruvbox palettes stay in
// sync between the system block and the explicit override; the pre-paint init applies/clears
// data-theme from localStorage (default = system); catalog.js marks the active option and applies,
// persists and closes the menu (pick, Escape, outside click) without throwing when storage is
// denied; and every localized page ships the control with the correct language labels and no flash.
const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8")
const CATALOG_SOURCE = readFileSync(new URL("./assets/catalog.js", import.meta.url), "utf8")

const source = await loadSource()
const overlays = await loadOverlays()
const localize = (lang: "es" | "en") => localizeSource(source, lang, overlays)
const PAGES: Record<"es" | "en", { home: string; catalog: string; guide: string }> = {
  es: { home: homePage("es", localize("es")), catalog: catalogPage("es", localize("es")), guide: guidePage("es", localize("es")) },
  en: { home: homePage("en", localize("en")), catalog: catalogPage("en", localize("en")), guide: guidePage("en", localize("en")) },
}
const NOT_FOUND = notFoundPage(source)
const THEME_KEY = "omr-theme"

// --- CSS palette contract ---------------------------------------------------------------

function parseDecls(body: string): Record<string, string> {
  const decls: Record<string, string> = {}
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) decls[match[1]] = match[2].trim()
  return decls
}

function blockBody(css: string, openBrace: number): string {
  let depth = 0
  for (let index = openBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1
    else if (css[index] === "}") {
      depth -= 1
      if (depth === 0) return css.slice(openBrace + 1, index)
    }
  }
  throw new Error("unterminated CSS block")
}

function blockAfterSelector(css: string, selector: string): string {
  const at = css.indexOf(selector)
  if (at < 0) throw new Error(`styles.css is missing the selector ${selector}`)
  return blockBody(css, css.indexOf("{", at))
}

function mediaLightBody(): string {
  const at = CSS.indexOf("@media (prefers-color-scheme: light)")
  if (at < 0) throw new Error("styles.css is missing the light color-scheme media block")
  return blockBody(CSS, CSS.indexOf("{", at))
}

describe("#given the two Gruvbox palettes #when the explicit override is compared to the system block #then they cannot drift", () => {
  test("#given styles.css #when the explicit light tokens are read #then they equal the media light tokens", () => {
    // given / when / then
    const media = parseDecls(mediaLightBody())
    const explicit = parseDecls(blockAfterSelector(CSS, ':root[data-theme="light"]'))
    expect(Object.keys(media).length).toBeGreaterThan(10)
    expect(explicit).toEqual(media)
  })

  test("#given styles.css #when color-scheme is read per palette #then dark declares dark and both light blocks declare light", () => {
    // given / when / then
    expect(/color-scheme\s*:\s*dark/.test(blockAfterSelector(CSS, ":root {"))).toBe(true)
    expect(/color-scheme\s*:\s*light/.test(mediaLightBody())).toBe(true)
    expect(/color-scheme\s*:\s*light/.test(blockAfterSelector(CSS, ':root[data-theme="light"]'))).toBe(true)
  })
})

// --- Pre-paint init (inline snippet) -----------------------------------------------------

class FakeRoot {
  readonly attributes = new Map<string, string>()
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
}

function runInit(stored: string | null, options: { throwOnGet?: boolean } = {}): FakeRoot {
  const root = new FakeRoot()
  const localStorage = {
    getItem(): string | null {
      if (options.throwOnGet) throw new Error("storage denied")
      return stored
    },
  }
  const documentStub = { documentElement: root }
  const run = new Function("localStorage", "document", THEME_INIT)
  run(localStorage, documentStub)
  return root
}

describe("#given no saved preference #when the pre-paint init runs #then the theme is system (no explicit attribute)", () => {
  test("#given empty or system storage #when init runs #then data-theme is absent so the CSS media query governs", () => {
    // given / when / then
    expect(runInit(null).getAttribute("data-theme")).toBe(null)
    expect(runInit("system").getAttribute("data-theme")).toBe(null)
  })
})

describe("#given a saved preference #when the pre-paint init runs #then it applies exactly that theme", () => {
  for (const value of ["light", "dark"] as const) {
    test(`#given the stored value ${value} #when init runs #then data-theme is ${value}`, () => {
      // given / when / then
      expect(runInit(value).getAttribute("data-theme")).toBe(value)
    })
  }

  test("#given an unknown stored value #when init runs #then it falls back to system (no attribute)", () => {
    // given / when / then
    expect(runInit("neon").getAttribute("data-theme")).toBe(null)
  })
})

describe("#given a storage that throws #when the pre-paint init runs #then it stays silent and defaults to system", () => {
  test("#given getItem throwing #when init runs #then no error propagates and no attribute is set", () => {
    // given
    let root: FakeRoot | null = null
    // when / then
    expect(() => { root = runInit(null, { throwOnGet: true }) }).not.toThrow()
    expect(root?.getAttribute("data-theme") ?? null).toBe(null)
  })
})

// --- catalog.js interaction (picker: open/close, apply, persistence, storage failure) -----

class FakeNode {
  readonly attributes = new Map<string, string>()
  readonly listeners: (() => void)[] = []
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }
  addEventListener(type: string, handler: () => void): void {
    if (type === "click") this.listeners.push(handler)
  }
  closest(): null {
    return null
  }
  focus(): void {}
  fire(): void {
    for (const handler of [...this.listeners]) handler()
  }
}

interface ThemeFixture {
  documentElement: FakeRoot
  button: FakeNode
  options: FakeNode[]
  menu: { hidden: boolean }
  writes: [string, string][]
  open(): void
  clickButton(): void
  clickOption(value: string): void
  pressEscape(): void
  clickOutside(): void
}

function createThemeFixture(stored: string | null, options: { throwOnSet?: boolean } = {}): ThemeFixture {
  const documentElement = new FakeRoot()
  const button = new FakeNode()
  button.setAttribute("aria-expanded", "false")
  const optionNodes = ["system", "light", "dark"].map((value) => {
    const node = new FakeNode()
    node.setAttribute("data-theme-option", value)
    node.setAttribute("aria-pressed", "false")
    return node
  })
  const menu = { hidden: true }
  const root = {
    querySelector(selector: string): unknown {
      if (selector === "[data-theme-menu-button]") return button
      if (selector === "[data-theme-menu]") return menu
      return null
    },
    querySelectorAll(selector: string): unknown[] {
      return selector === "[data-theme-option]" ? optionNodes : []
    },
    contains(node: unknown): boolean {
      return node === button || node === menu || optionNodes.includes(node as FakeNode)
    },
  }
  const loadHandlers: (() => void)[] = []
  const keyHandlers: ((event: { key: string }) => void)[] = []
  const clickHandlers: ((event: { target: unknown }) => void)[] = []
  const writes: [string, string][] = []
  let current = stored
  const storage = {
    getItem(): string | null {
      return current
    },
    setItem(key: string, value: string): void {
      if (options.throwOnSet) throw new Error("quota exceeded")
      current = value
      writes.push([key, value])
    },
  }
  const documentStub = {
    documentElement,
    body: {},
    addEventListener(type: string, handler: unknown): void {
      if (type === "keydown") keyHandlers.push(handler as (event: { key: string }) => void)
      if (type === "click") clickHandlers.push(handler as (event: { target: unknown }) => void)
    },
    createElement(tag: string): unknown {
      return { tagName: tag.toUpperCase(), style: {}, setAttribute: () => {}, select: () => {}, remove: () => {}, appendChild: () => {} }
    },
    getElementById(): null {
      return null
    },
    querySelector(selector: string): unknown {
      return selector === "[data-theme-switch]" ? root : null
    },
    execCommand(): boolean {
      return true
    },
  }
  const windowStub = {
    localStorage: storage,
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
    documentElement,
    button,
    options: optionNodes,
    menu,
    writes,
    open(): void {
      for (const handler of [...loadHandlers]) handler()
    },
    clickButton(): void {
      button.fire()
      for (const handler of [...clickHandlers]) handler({ target: button })
    },
    clickOption(value: string): void {
      const node = optionNodes.find((n) => n.getAttribute("data-theme-option") === value)
      if (!node) return
      node.fire()
      for (const handler of [...clickHandlers]) handler({ target: node })
    },
    pressEscape(): void {
      for (const handler of [...keyHandlers]) handler({ key: "Escape" })
    },
    clickOutside(): void {
      for (const handler of [...clickHandlers]) handler({ target: { outside: true, closest: () => null } })
    },
  }
}

describe("#given a saved preference #when the page loads #then the menu marks it and stays closed", () => {
  test("#given light stored #when DOMContentLoaded fires #then the light option is pressed and the menu is hidden", () => {
    // given
    const fixture = createThemeFixture("light")
    // when
    fixture.open()
    // then
    expect(fixture.options.map((o) => [o.getAttribute("data-theme-option"), o.getAttribute("aria-pressed")])).toEqual([
      ["system", "false"], ["light", "true"], ["dark", "false"],
    ])
    expect(fixture.menu.hidden).toBe(true)
    expect(fixture.button.getAttribute("aria-expanded")).toBe("false")
  })

  test("#given no stored value #when DOMContentLoaded fires #then system is marked", () => {
    // given
    const fixture = createThemeFixture(null)
    // when
    fixture.open()
    // then
    expect(fixture.options.find((o) => o.getAttribute("data-theme-option") === "system")?.getAttribute("aria-pressed")).toBe("true")
  })
})

describe("#given the visitor opens the picker #when the button is pressed #then the menu toggles and aria-expanded follows", () => {
  test("#given a closed menu #when the button is pressed twice #then it opens then closes", () => {
    // given
    const fixture = createThemeFixture(null)
    fixture.open()
    // when
    fixture.clickButton()
    // then
    expect([fixture.menu.hidden, fixture.button.getAttribute("aria-expanded")]).toEqual([false, "true"])
    // when
    fixture.clickButton()
    // then
    expect([fixture.menu.hidden, fixture.button.getAttribute("aria-expanded")]).toEqual([true, "false"])
  })
})

describe("#given the visitor picks a mode #when an option is chosen #then it applies, persists and closes", () => {
  test("#given system #when Oscuro is chosen #then data-theme=dark is stored and the menu closes", () => {
    // given
    const fixture = createThemeFixture(null)
    fixture.open()
    fixture.clickButton()
    // when
    fixture.clickOption("dark")
    // then
    expect(fixture.documentElement.getAttribute("data-theme")).toBe("dark")
    expect(fixture.writes).toEqual([[THEME_KEY, "dark"]])
    expect(fixture.menu.hidden).toBe(true)
    expect(fixture.options.find((o) => o.getAttribute("data-theme-option") === "dark")?.getAttribute("aria-pressed")).toBe("true")
  })

  test("#given dark #when Sistema is chosen #then the explicit attribute is removed and system is stored", () => {
    // given
    const fixture = createThemeFixture("dark")
    fixture.open()
    fixture.clickButton()
    // when
    fixture.clickOption("system")
    // then
    expect(fixture.documentElement.getAttribute("data-theme")).toBe(null)
    expect(fixture.writes).toEqual([[THEME_KEY, "system"]])
  })
})

describe("#given an open menu #when it is dismissed #then Escape and an outside click both close it", () => {
  test("#given an open menu #when Escape is pressed #then the menu closes", () => {
    // given
    const fixture = createThemeFixture(null)
    fixture.open()
    fixture.clickButton()
    // when
    fixture.pressEscape()
    // then
    expect(fixture.menu.hidden).toBe(true)
    expect(fixture.button.getAttribute("aria-expanded")).toBe("false")
  })

  test("#given an open menu #when the page outside is clicked #then the menu closes", () => {
    // given
    const fixture = createThemeFixture(null)
    fixture.open()
    fixture.clickButton()
    // when
    fixture.clickOutside()
    // then
    expect(fixture.menu.hidden).toBe(true)
  })
})

describe("#given a storage that rejects writes #when a mode is chosen #then the theme still applies without throwing", () => {
  test("#given setItem throwing #when Oscuro is chosen #then data-theme is applied and no error escapes", () => {
    // given
    const fixture = createThemeFixture(null, { throwOnSet: true })
    fixture.open()
    fixture.clickButton()
    // when / then
    expect(() => fixture.clickOption("dark")).not.toThrow()
    expect(fixture.documentElement.getAttribute("data-theme")).toBe("dark")
    expect(fixture.writes).toEqual([])
  })
})

// --- Markup, both languages and routes, anti-flash, a11y ---------------------------------

describe("#given every localized page #when the theme picker is rendered #then it is localized and label-free", () => {
  for (const lang of ["es", "en"] as const) {
    for (const [name, html] of Object.entries(PAGES[lang])) {
      test(`#given the ${lang} ${name} page #when scanned #then it carries the picker button, the hidden localized menu and no visible label`, () => {
        // given / when / then
        const copy = THEME_COPY[lang]
        expect(html).toContain("data-theme-switch")
        expect(/<button class="theme-picker__button"[^>]*data-theme-menu-button[^>]*aria-haspopup="true"[^>]*aria-expanded="false"[^>]*aria-controls="theme-menu"[^>]*aria-label="[^"]+"/.test(html)).toBe(true)
        expect(html).toContain('class="theme-picker__menu" id="theme-menu" data-theme-menu hidden')
        expect(html).toContain("theme-picker__icon--light")
        expect(html).toContain("theme-picker__icon--dark")
        expect(html).toContain("theme-picker__icon--system")
        for (const value of ["system", "light", "dark"] as const) {
          expect(html.includes(`data-theme-option="${value}" aria-pressed="false">${copy[value]}</button>`)).toBe(true)
        }
        expect(html.includes('class="theme-picker__label"')).toBe(false)
      })
    }
  }

  test("#given the EN pages #when scanned #then no Spanish theme word leaks in", () => {
    // given / when / then
    for (const html of Object.values(PAGES.en)) {
      for (const spanish of ["Tema", "Sistema", "Claro", "Oscuro"]) {
        expect([spanish, html.includes(spanish)]).toEqual([spanish, false])
      }
    }
  })

  test("#given the ES pages #when scanned #then no English theme word leaks in", () => {
    // given / when / then
    for (const html of Object.values(PAGES.es)) {
      for (const english of [">Theme<", ">System<", ">Light<", ">Dark<"]) {
        expect([english, html.includes(english)]).toEqual([english, false])
      }
    }
  })
})

describe("#given every page #when the head is read #then the pre-paint init runs before the stylesheet and is the only inline script", () => {
  const allPages: [string, string][] = [
    ["es/home", PAGES.es.home], ["en/home", PAGES.en.home],
    ["es/catalog", PAGES.es.catalog], ["en/catalog", PAGES.en.catalog],
    ["es/guide", PAGES.es.guide], ["en/guide", PAGES.en.guide],
    ["404", NOT_FOUND],
  ]
  for (const [name, html] of allPages) {
    test(`#given the ${name} page #when the head is scanned #then THEME_INIT precedes the stylesheet and no other inline script exists`, () => {
      // given
      const inline = `<script>${THEME_INIT}</script>`
      const initIndex = html.indexOf(inline)
      const styleIndex = html.indexOf("/assets/styles.css")
      // when / then
      expect([name, initIndex >= 0]).toEqual([name, true])
      expect([name, styleIndex >= 0]).toEqual([name, true])
      expect([name, initIndex < styleIndex]).toEqual([name, true])
      const inlineTags = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)]
      expect([name, inlineTags.length]).toEqual([name, 1])
    })
  }
})

describe("#given the theme picker styles #when accessibility and motion are inspected #then focus, target size and a reduced-motion-gated transition are present", () => {
  test("#given styles.css #when the control rules are read #then button and option focus-visible and 44px target are present", () => {
    // given / when / then
    expect(/\.theme-picker__button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/.test(CSS)).toBe(true)
    expect(/\.theme-picker__button\s*\{[^}]*min-block-size:\s*2\.25rem/.test(CSS)).toBe(true)
    expect(/\.theme-picker__option:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/.test(CSS)).toBe(true)
  })

  test("#given styles.css #when motion is inspected #then the icon transition is gated on reduced-motion and the active option is not colour-only", () => {
    // given / when / then
    expect(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\.theme-picker__icon--light,\s*\.theme-picker__icon--dark,\s*\.theme-picker__icon--system\s*\{[^}]*transition:\s*opacity/.test(CSS)).toBe(true)
    expect(/\.theme-picker__option\[aria-pressed="true"\]\s*\{[^}]*font-weight/.test(CSS)).toBe(true)
    expect(/\.theme-picker__option\[aria-pressed="true"\]::after\s*\{[^}]*content:/.test(CSS)).toBe(true)
    expect(!/box-shadow/.test(CSS)).toBe(true)
  })
})
