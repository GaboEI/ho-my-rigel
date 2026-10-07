// Rigel V2 CLI `refresh-model-capabilities`.
//
// V1 refreshed a bundled models.dev cache. The V2 host owns the model catalog,
// so this command resolves the catalog from the running V2 host and writes a
// capabilities snapshot into the Rigel state dir. It never launches OpenCode and
// never reads the V1 cache.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { fail, parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

function defaultOut(io) {
  const labRoot = io.env.RIGEL_V2_LAB_ROOT ?? path.join(io.home, ".local", "share", "opencode-v2-lab")
  return path.join(labRoot, "rigel", "model-capabilities.json")
}

export const refreshModelCapabilitiesCommand = {
  name: "refresh-model-capabilities",
  summary: "Resolve the V2 host model catalog into a capabilities snapshot",
  usage: "rigel-v2 refresh-model-capabilities [--host <url>] [--out <file>] [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const host = options.host !== undefined
      ? String(options.host)
      : io.env.RIGEL_V2_LAB_URL ?? "http://127.0.0.1:4097"
    const fetchImpl = io.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== "function") return fail(io, "no fetch implementation available")

    const password = io.env.RIGEL_V2_LAB_PASSWORD
    const headers = typeof password === "string" && password.length > 0
      ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
      : {}

    let response
    try {
      response = await fetchImpl(`${host}/api/model`, { headers, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      return fail(io, `host unreachable at ${host}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) return fail(io, `host returned HTTP ${response.status} at ${host}`)

    let body
    try {
      body = await response.json()
    } catch (error) {
      return fail(io, `host returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const models = Array.isArray(body?.data) ? body.data : []
    if (models.length === 0) return fail(io, `host returned no models at ${host}`)

    const snapshot = {
      sourceUrl: `${host}/api/model`,
      generatedAt: new Date().toISOString(),
      modelCount: models.length,
      models,
    }
    const out = options.out !== undefined ? String(options.out) : defaultOut(io)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`)

    if (options.json === true) {
      writeJson(io, { sourceUrl: snapshot.sourceUrl, generatedAt: snapshot.generatedAt, modelCount: snapshot.modelCount, out })
    } else {
      io.stdout.write(`Model capabilities refreshed: ${snapshot.modelCount} models -> ${out}\n`)
    }
    return 0
  },
}
