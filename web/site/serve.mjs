import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

import { normalizeBasePath, SITE } from "./lib/config.mjs"
import { buildSite } from "./build.mjs"

const port = Number(process.env.PORT ?? 4173)
const basePath = normalizeBasePath(SITE.basePath)
const root = fileURLToPath(SITE.outDir)

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
])

function resolvePath(urlPath) {
  if (!urlPath.startsWith(basePath)) return null
  const withoutBase = urlPath.slice(basePath.length)
  const clean = normalize(withoutBase || "index.html").replace(/^\.\.\//, "")
  return join(root, clean.endsWith("/") ? `${clean}index.html` : clean)
}

await buildSite()

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`)
  let file = resolvePath(url.pathname)
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end(`Outside ${basePath} preview basePath`)
    return
  }
  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, "index.html")
    const body = await readFile(file)
    res.writeHead(200, { "content-type": types.get(extname(file)) ?? "application/octet-stream" })
    res.end(body)
  } catch {
    const body = await readFile(join(root, "404.html"))
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" })
    res.end(body)
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`Oh My Rigel W5 preview: http://127.0.0.1:${port}${basePath}`)
})
