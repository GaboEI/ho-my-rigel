import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8")

interface CssBlock {
  body: string
  end: number
  start: number
}

const FONT_FILES = [
  "newsreader-latin-var.woff2",
  "plex-mono-400-latin.woff2",
  "plex-mono-500-latin.woff2",
  "plex-mono-600-latin.woff2",
]

function readBlock(css: string, openBrace: number): CssBlock {
  let depth = 0
  for (let index = openBrace; index < css.length; index += 1) {
    const char = css[index]
    if (char === "{") depth += 1
    if (char === "}") depth -= 1
    if (depth === 0) return { body: css.slice(openBrace + 1, index), end: index + 1, start: openBrace }
  }
  throw new Error("unterminated CSS block")
}

function colorSchemeMediaBody(css: string): string {
  const media = css.indexOf("@media (prefers-color-scheme: light)")
  if (media < 0) throw new Error("styles.css is missing the light color-scheme media block")
  const open = css.indexOf("{", media)
  if (open < 0) throw new Error("styles.css light color-scheme media block has no body")
  return readBlock(css, open).body
}

function mediaRanges(css: string): CssBlock[] {
  const ranges: CssBlock[] = []
  let offset = 0
  while (offset < css.length) {
    const media = css.indexOf("@media", offset)
    if (media < 0) return ranges
    const open = css.indexOf("{", media)
    if (open < 0) throw new Error("@media rule has no body")
    const block = readBlock(css, open)
    ranges.push(block)
    offset = block.end
  }
  return ranges
}

function isInside(index: number, ranges: CssBlock[]): boolean {
  return ranges.some((range) => index > range.start && index < range.end)
}

function topLevelFontFaces(css: string): string[] {
  const ranges = mediaRanges(css)
  return [...css.matchAll(/@font-face\s*\{/g)]
    .filter((match) => !isInside(match.index ?? 0, ranges))
    .map((match) => readBlock(css, (match.index ?? 0) + match[0].lastIndexOf("{")).body)
}

describe("#given the site font declarations #when color scheme changes #then fonts are registered outside theme media", () => {
  test("#given styles.css #when the light media body is inspected #then it contains no font-face declarations", () => {
    // given / when / then
    expect(colorSchemeMediaBody(CSS).includes("@font-face")).toBe(false)
  })

  test("#given styles.css #when top-level font faces are read #then all self-hosted faces are common to dark and light", () => {
    // given
    const topLevel = topLevelFontFaces(CSS)
    const joined = topLevel.join("\n")
    // when / then
    expect(topLevel.length).toBe(4)
    expect(joined).toContain('font-family: "Newsreader"')
    expect(joined).toContain('font-family: "IBM Plex Mono"')
    for (const file of FONT_FILES) expect(joined).toContain(file)
  })

  test("#given a media-gated font-face #when the helper scans it #then the source gate can detect the regression", () => {
    // given
    const broken = `:root { --font-display: Newsreader; }\n@media (prefers-color-scheme: light) {\n@font-face { font-family: "Newsreader"; src: url("./fonts/newsreader-latin-var.woff2"); }\n:root { color-scheme: light; }\n}`
    // when / then
    expect(colorSchemeMediaBody(broken).includes("@font-face")).toBe(true)
    expect(topLevelFontFaces(broken)).toEqual([])
  })
})
