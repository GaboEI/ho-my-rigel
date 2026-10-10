import { mkdir, rm, writeFile, copyFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { absoluteUrl, SITE } from "./lib/config.mjs"
import { loadSource } from "./lib/data.mjs"
import { loadOverlays, localizeSource } from "./lib/i18n.mjs"
import { agentPage, agentsPage, catalogPage, guidePage, homePage, notFoundPage } from "./lib/render.mjs"

const outPath = fileURLToPath(SITE.outDir)

async function write(rel, content) {
  const target = new URL(rel, SITE.outDir)
  await mkdir(dirname(fileURLToPath(target)), { recursive: true })
  await writeFile(target, content)
}

export async function buildSite() {
  const source = await loadSource()
  const overlays = await loadOverlays()
  await rm(SITE.outDir, { recursive: true, force: true })
  await mkdir(new URL("assets/", SITE.outDir), { recursive: true })
  await copyFile(new URL("./styles.css", import.meta.url), new URL("assets/styles.css", SITE.outDir))
  await copyFile(new URL("./assets/catalog.js", import.meta.url), new URL("assets/catalog.js", SITE.outDir))
  await copyFile(new URL("./assets/favicon-16.svg", import.meta.url), new URL("assets/favicon-16.svg", SITE.outDir))
  await copyFile(new URL("./assets/favicon-32.svg", import.meta.url), new URL("assets/favicon-32.svg", SITE.outDir))
  await mkdir(new URL("assets/fonts/", SITE.outDir), { recursive: true })
  for (const file of ["newsreader-latin-var.woff2", "plex-mono-400-latin.woff2", "plex-mono-500-latin.woff2", "plex-mono-600-latin.woff2", "OFL-Newsreader.txt", "OFL-IBM-Plex-Mono.txt", "PROVENANCE.md"]) {
    await copyFile(new URL(`./assets/fonts/${file}`, import.meta.url), new URL(`assets/fonts/${file}`, SITE.outDir))
  }
  await write("index.html", homePage("en", localizeSource(source, "en", overlays)))
  await write("404.html", notFoundPage(source))

  const routes = ["/", "/404.html"]
  for (const lang of ["es", "en"]) {
    const localized = localizeSource(source, lang, overlays)
    await write(`${lang}/index.html`, homePage(lang, localized))
    await write(`${lang}/catalogo/index.html`, catalogPage(lang, localized))
    await write(`${lang}/agentes-y-modelos/index.html`, agentsPage(lang, localized))
    await write(`${lang}/agentes-y-modelos/guia-modelos/index.html`, guidePage(lang, localized))
    routes.push(`/${lang}/`, `/${lang}/catalogo/`, `/${lang}/agentes-y-modelos/`, `/${lang}/agentes-y-modelos/guia-modelos/`)

    for (const agent of localized.agents.agents) {
      await write(`${lang}/agentes-y-modelos/${agent.id}/index.html`, agentPage(lang, localized, agent))
      routes.push(`/${lang}/agentes-y-modelos/${agent.id}/`)
    }
  }
  await write("route-manifest.json", `${JSON.stringify({ schemaVersion: 1, basePath: SITE.basePath, origin: SITE.origin, seal: source.seal, routes: routes.sort() }, null, 2)}\n`)
  const sitemapRoutes = routes.filter((route) => route !== "/404.html")
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapRoutes.map((route) => `  <url><loc>${absoluteUrl(route)}</loc></url>`).join("\n")}\n</urlset>\n`
  await write("sitemap.xml", sitemap)
  await write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${absoluteUrl("/sitemap.xml")}\n`)
  return { outPath, routes: routes.length }
}

if (import.meta.main) {
  const result = await buildSite()
  console.log(`Built ${result.routes} routes into ${result.outPath}`)
}
