import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildSite } from "./build.mjs"
import { SITE } from "./lib/config.mjs"

const CUSTOM_DOMAIN = "omr.gabodev.dev"
const CUSTOM_ORIGIN = `https://${CUSTOM_DOMAIN}`
const outPath = fileURLToPath(SITE.outDir)

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}

function readDist(rel: string): string {
  return readFileSync(join(outPath, rel), "utf8")
}

describe("#given the custom-domain web artifact #when it is built #then it serves from the domain root", () => {
  test("#given the configured site #when defaults are read #then the custom domain root is the publication contract", () => {
    // given / when / then
    expect(SITE.basePath).toBe("/")
    expect(SITE.origin).toBe(CUSTOM_ORIGIN)
  })

  test("#given the generated artifact #when SEO, language and asset references are inspected #then no project-path URL survives", async () => {
    // given
    await buildSite()

    // when
    const cnamePath = join(outPath, "CNAME")
    const robots = readDist("robots.txt")
    const sitemap = readDist("sitemap.xml")
    const rootHtml = readDist("index.html")
    const emittedFiles = collectFiles(outPath).filter((file) => /\.(html|css|js|xml|txt|json)$/.test(file))

    // then
    expect(existsSync(cnamePath)).toBe(true)
    expect(readFileSync(cnamePath, "utf8").trim()).toBe(CUSTOM_DOMAIN)
    expect(robots).toContain(`Sitemap: ${CUSTOM_ORIGIN}/sitemap.xml`)

    const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(sitemapLocs.length).toBeGreaterThan(0)
    expect(sitemapLocs.every((loc) => loc.startsWith(`${CUSTOM_ORIGIN}/`))).toBe(true)

    expect(rootHtml).toContain(`rel="canonical" href="${CUSTOM_ORIGIN}/en/"`)
    expect(rootHtml).toContain('href="/es/"')
    expect(rootHtml).toContain('href="/en/"')
    expect(rootHtml).toContain('src="/assets/catalog.js"')
    expect(rootHtml).toContain('href="/assets/styles.css"')

    for (const file of emittedFiles) {
      const content = readFileSync(file, "utf8")
      expect(content).not.toMatch(/(?:href|src)="\/oh-my-rigel\//)
      expect(content).not.toContain("https://gaboei.github.io/oh-my-rigel/")
    }
  })
})
