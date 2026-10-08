/**
 * OpenGateway provider injection, native OpenCode V2 server module.
 *
 * V1 `features/opengateway-provider/` injected an `opengateway` provider into
 * opencode's live config ONLY when a real credential existed (the
 * `OPENGATEWAY_API_KEY` env var or an `opengateway` entry in opencode's
 * auth.json). Without a credential the config was left exactly as it came in.
 * With one it filled only missing keys (user values won) and added each bundled
 * catalog model only when its id was absent, deep-cloning every injected value.
 *
 * V2 exposes the same effect as a provider transform:
 *   `context.provider.transform((editor) => editor.add({ info, models }))`
 * The credential gate is re-checked at install time, so `install` returns
 * WITHOUT calling the transform when no credential is present: a byte-identical
 * no-op. Auth is read from an injected `readAuth()`; the default reader only
 * reads `$XDG_DATA_HOME/opencode/auth.json` and never a V1-install auth file.
 *
 * V1 source ported here:
 *   packages/omo-opencode/src/features/opengateway-provider/index.ts
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export const OPENGATEWAY_PROVIDER_ID = "opengateway"
export const OPENGATEWAY_PROVIDER_NAME = "OpenGateway"
export const OPENGATEWAY_PROVIDER_NPM = "@ai-sdk/openai-compatible"
export const OPENGATEWAY_BASE_URL = "https://apis.opengateway.ai/v1"
export const OPENGATEWAY_ENV_VAR = "OPENGATEWAY_API_KEY"

const CATALOG_URL = new URL("./rigel-v2-opengateway-models.json", import.meta.url)

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Deep clone via the platform primitive, degrading to a JSON round-trip. */
function deepClone(value) {
  if (value === undefined || value === null || typeof value !== "object") return value
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value)
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return Array.isArray(value) ? [] : {}
  }
}

/** Load the bundled catalog once. Tolerant: a read failure yields an empty map. */
let cachedCatalog
export function loadOpenGatewayCatalog() {
  if (cachedCatalog) return cachedCatalog
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_URL, "utf-8"))
    cachedCatalog = isRecord(parsed) ? parsed : {}
  } catch (error) {
    if (!(error instanceof Error)) throw error
    cachedCatalog = {}
  }
  return cachedCatalog
}

/**
 * Default auth reader: `$XDG_DATA_HOME/opencode/auth.json` (falling back to
 * `~/.local/share`). Never reads a V1-specific location; returns `{}` on any
 * absence or parse failure.
 */
export function readOpenCodeAuthFile(env = process.env) {
  const base = typeof env?.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : join(homedir(), ".local", "share")
  const file = join(base, "opencode", "auth.json")
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    return isRecord(parsed) ? parsed : {}
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return {}
  }
}

function safeReadAuth(readAuth) {
  try {
    return readAuth()
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return {}
  }
}

/** Credential gate: a non-empty env key OR an `opengateway` auth entry. */
export function hasOpenGatewayCredential({ env, readAuth } = {}) {
  const apiKey = env?.[OPENGATEWAY_ENV_VAR]
  if (typeof apiKey === "string" && apiKey.length > 0) return true
  const auth = isRecord(readAuth) ? readAuth : safeReadAuth(readAuth)
  return isRecord(auth) && auth[OPENGATEWAY_PROVIDER_ID] !== undefined && auth[OPENGATEWAY_PROVIDER_ID] !== null
}

/** V1 `fillMissing`: fills keys absent from `target`; user values survive. */
export function fillMissing(target, defaults) {
  if (!isRecord(target) || !isRecord(defaults)) return
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const existing = target[key]
    if (existing === undefined) {
      target[key] = deepClone(defaultValue)
      continue
    }
    if (isRecord(existing) && isRecord(defaultValue)) fillMissing(existing, defaultValue)
  }
}

/**
 * Build the `{ info, models }` payload the V2 provider editor consumes,
 * preserving any user-provided values and cloning every default and catalog
 * entry so nothing aliases module state.
 *
 * `existing` may be shaped `{ info, models }` (editor shape) or a bare provider
 * object; a bare object is treated as user `info`.
 */
export function buildOpenGatewayProvider(existing, catalog = loadOpenGatewayCatalog()) {
  const source = isRecord(existing) ? existing : {}
  const info = deepClone(isRecord(source.info) ? source.info : source)
  fillMissing(info, {
    id: OPENGATEWAY_PROVIDER_ID,
    name: OPENGATEWAY_PROVIDER_NAME,
    npm: OPENGATEWAY_PROVIDER_NPM,
    env: [OPENGATEWAY_ENV_VAR],
    options: { baseURL: OPENGATEWAY_BASE_URL },
  })

  const models = deepClone(isRecord(source.models) ? source.models : {})
  for (const [modelID, modelConfig] of Object.entries(catalog)) {
    if (models[modelID] !== undefined) continue
    models[modelID] = deepClone(modelConfig)
  }

  return { info, models }
}

/** Read an existing opengateway provider from whatever read surface the editor exposes. */
function readExistingProvider(editor) {
  try {
    if (typeof editor?.get === "function") {
      const value = editor.get(OPENGATEWAY_PROVIDER_ID)
      if (isRecord(value)) return value
    }
    if (typeof editor?.providers?.get === "function") {
      const value = editor.providers.get(OPENGATEWAY_PROVIDER_ID)
      if (isRecord(value)) return value
    }
    if (typeof editor?.existing?.get === "function") {
      const value = editor.existing.get(OPENGATEWAY_PROVIDER_ID)
      if (isRecord(value)) return value
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  return undefined
}

/**
 * Apply the built provider to a V2 editor. Primary shape is
 * `editor.add({ info, models })`; when the editor lacks `add` but exposes a
 * per-model setter, the info is set and each model is set individually.
 */
export function applyOpenGatewayProviderToEditor(editor, catalog = loadOpenGatewayCatalog()) {
  if (!editor || typeof editor !== "object") return
  const built = buildOpenGatewayProvider(readExistingProvider(editor), catalog)
  if (typeof editor.add === "function") {
    editor.add({ info: built.info, models: built.models })
    return
  }
  if (typeof editor.set === "function") {
    editor.set({ info: built.info })
  } else if (typeof editor.info?.set === "function") {
    editor.info.set(built.info)
  }
  if (typeof editor.models?.set === "function") {
    for (const [modelID, modelConfig] of Object.entries(built.models)) {
      editor.models.set(modelID, modelConfig)
    }
  }
}

/**
 * Build the V2 provider transform.
 *
 *   { catalog, readAuth, env, log } = {}
 *     catalog   override the bundled catalog (tests)
 *     readAuth  injected auth reader; default reads XDG auth.json only
 *     env       environment source; default `process.env`
 *     log       optional `(entry) => void` observer
 *
 * Returns `{ enabled, install(context) }`. `enabled` is the credential snapshot
 * for the orchestrator; `install` re-checks the gate and, without a credential,
 * returns before touching `context.provider.transform`.
 */
export function createOpenGatewayProviderTransform({ catalog, readAuth, env, log } = {}) {
  const envVars = isRecord(env) ? env : process.env
  const authReader = typeof readAuth === "function" ? readAuth : () => readOpenCodeAuthFile(envVars)
  const catalogSource = isRecord(catalog) ? catalog : loadOpenGatewayCatalog()
  const logger = typeof log === "function" ? log : () => {}

  const gate = () => hasOpenGatewayCredential({ env: envVars, readAuth: () => authReader() })

  return {
    enabled: gate(),
    install(context) {
      try {
        if (!gate()) {
          logger({ event: "opengateway.skip", reason: "no-credential" })
          return undefined
        }
        const transform = context?.provider?.transform
        if (typeof transform !== "function") {
          logger({ event: "opengateway.skip", reason: "no-provider-transform" })
          return undefined
        }
        const result = transform((editor) => {
          try {
            applyOpenGatewayProviderToEditor(editor, catalogSource)
            logger({ event: "opengateway.injected" })
          } catch (error) {
            logger({ event: "opengateway.transform-failed", error: error instanceof Error ? error.message : String(error) })
          }
        })
        return result
      } catch (error) {
        logger({ event: "opengateway.install-failed", error: error instanceof Error ? error.message : String(error) })
        return undefined
      }
    },
  }
}

export default createOpenGatewayProviderTransform
