export const SITE = {
  basePath: process.env.OMR_WEB_BASE_PATH ?? "/",
  origin: process.env.OMR_WEB_ORIGIN ?? "https://omr.gabodev.dev",
  outDir: new URL("../dist/", import.meta.url),
  sourceDir: new URL("../../data/", import.meta.url),
}

export function normalizeBasePath(basePath = SITE.basePath) {
  if (basePath === "") return "/"
  const withStart = basePath.startsWith("/") ? basePath : `/${basePath}`
  return withStart.endsWith("/") ? withStart : `${withStart}/`
}

export function publicPath(logicalPath, basePath = SITE.basePath) {
  const base = normalizeBasePath(basePath)
  const logical = logicalPath.startsWith("/") ? logicalPath.slice(1) : logicalPath
  return `${base}${logical}`.replace(/\/+/g, "/")
}

export function absoluteUrl(logicalPath, origin = SITE.origin, basePath = SITE.basePath) {
  return new URL(publicPath(logicalPath, basePath), origin).toString()
}
