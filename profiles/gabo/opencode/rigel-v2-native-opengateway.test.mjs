import { describe, expect, test } from "bun:test"
import {
  buildOpenGatewayProvider,
  createOpenGatewayProviderTransform,
  hasOpenGatewayCredential,
  loadOpenGatewayCatalog,
  OPENGATEWAY_BASE_URL,
  OPENGATEWAY_ENV_VAR,
  OPENGATEWAY_PROVIDER_ID,
} from "./rigel-v2-native-opengateway.mjs"

const catalog = loadOpenGatewayCatalog()
const catalogIds = Object.keys(catalog)

function createTransformContext(editor) {
  const state = { calls: 0, editors: [] }
  const context = {
    provider: {
      transform(callback) {
        state.calls += 1
        state.editors.push(editor)
        callback(editor)
        return { dispose() {} }
      },
    },
  }
  return { context, state }
}

describe("loadOpenGatewayCatalog", () => {
  test("#then the bundled catalog ships at least 60 models", () => {
    expect(catalogIds.length).toBeGreaterThanOrEqual(60)
  })
})

describe("hasOpenGatewayCredential", () => {
  test("#given a non-empty env key #then it reports a credential", () => {
    expect(hasOpenGatewayCredential({ env: { [OPENGATEWAY_ENV_VAR]: "sk-x" }, readAuth: () => ({}) })).toBe(true)
  })

  test("#given an empty env key and no auth entry #then it reports none", () => {
    expect(hasOpenGatewayCredential({ env: { [OPENGATEWAY_ENV_VAR]: "" }, readAuth: () => ({}) })).toBe(false)
  })

  test("#given an opengateway auth entry #then it reports a credential", () => {
    expect(hasOpenGatewayCredential({ env: {}, readAuth: () => ({ [OPENGATEWAY_PROVIDER_ID]: { type: "api", key: "k" } }) })).toBe(true)
  })

  test("#given an auth entry for another provider #then it reports none", () => {
    expect(hasOpenGatewayCredential({ env: {}, readAuth: () => ({ anthropic: { type: "oauth" } }) })).toBe(false)
  })

  test("#given a throwing auth reader #then it degrades to no credential", () => {
    expect(hasOpenGatewayCredential({ env: {}, readAuth: () => { throw new Error("no auth") } })).toBe(false)
  })
})

describe("buildOpenGatewayProvider", () => {
  test("#given no existing provider #then it fills the provider info and the whole catalog", () => {
    const built = buildOpenGatewayProvider(undefined, catalog)

    expect(built.info.id).toBe(OPENGATEWAY_PROVIDER_ID)
    expect(built.info.name).toBe("OpenGateway")
    expect(built.info.npm).toBe("@ai-sdk/openai-compatible")
    expect(built.info.env).toEqual([OPENGATEWAY_ENV_VAR])
    expect(built.info.options.baseURL).toBe(OPENGATEWAY_BASE_URL)
    expect(Object.keys(built.models)).toHaveLength(catalogIds.length)
  })

  test("#given a user-authored provider #then user values survive and only gaps are filled", () => {
    const built = buildOpenGatewayProvider(
      {
        info: { name: "My Gateway", options: { baseURL: "https://proxy.internal/v1", apiKey: "inline-key" } },
        models: { "acme/private-model": { name: "Private Model" } },
      },
      catalog,
    )

    expect(built.info.name).toBe("My Gateway")
    expect(built.info.options.baseURL).toBe("https://proxy.internal/v1")
    expect(built.info.options.apiKey).toBe("inline-key")
    expect(built.info.npm).toBe("@ai-sdk/openai-compatible")
    expect(built.info.env).toEqual([OPENGATEWAY_ENV_VAR])
    expect(built.models["acme/private-model"]).toEqual({ name: "Private Model" })
    expect(Object.keys(built.models)).toHaveLength(catalogIds.length + 1)
  })

  test("#given a user override of a catalog id #then the user entry wins", () => {
    const overridden = catalogIds[0]
    const built = buildOpenGatewayProvider({ models: { [overridden]: { name: "Pinned" } } }, catalog)

    expect(built.models[overridden]).toEqual({ name: "Pinned" })
    expect(Object.keys(built.models)).toHaveLength(catalogIds.length)
  })

  test("#given a built provider #then mutating it never touches the module catalog", () => {
    const first = buildOpenGatewayProvider(undefined, catalog)
    const firstId = catalogIds[0]
    first.models[firstId].name = "mutated"
    first.info.options.baseURL = "https://mutated"

    const second = buildOpenGatewayProvider(undefined, catalog)
    expect(second.models[firstId].name).not.toBe("mutated")
    expect(second.info.options.baseURL).toBe(OPENGATEWAY_BASE_URL)
    expect(catalog[firstId].name).not.toBe("mutated")
  })
})

describe("createOpenGatewayProviderTransform", () => {
  test("#given a credential #then install calls provider.transform once with the provider and catalog", () => {
    const added = []
    const editor = { add: (entry) => added.push(entry) }
    const { context, state } = createTransformContext(editor)
    const transform = createOpenGatewayProviderTransform({ env: { [OPENGATEWAY_ENV_VAR]: "sk-x" }, readAuth: () => ({}), log: () => {} })

    expect(transform.enabled).toBe(true)
    transform.install(context)

    expect(state.calls).toBe(1)
    expect(added).toHaveLength(1)
    expect(added[0].info.name).toBe("OpenGateway")
    expect(added[0].info.npm).toBe("@ai-sdk/openai-compatible")
    expect(added[0].info.options.baseURL).toBe(OPENGATEWAY_BASE_URL)
    expect(Object.keys(added[0].models)).toHaveLength(catalogIds.length)
  })

  test("#given no credential #then install never calls provider.transform", () => {
    const editor = { add: () => { throw new Error("must not be called") } }
    const { context, state } = createTransformContext(editor)
    const transform = createOpenGatewayProviderTransform({ env: {}, readAuth: () => ({}), log: () => {} })

    expect(transform.enabled).toBe(false)
    expect(transform.install(context)).toBeUndefined()
    expect(state.calls).toBe(0)
  })

  test("#given an auth-file credential #then install still injects", () => {
    const added = []
    const editor = { add: (entry) => added.push(entry) }
    const { context, state } = createTransformContext(editor)
    const transform = createOpenGatewayProviderTransform({
      env: {},
      readAuth: () => ({ [OPENGATEWAY_PROVIDER_ID]: { type: "api", key: "k" } }),
      log: () => {},
    })

    expect(transform.enabled).toBe(true)
    transform.install(context)
    expect(state.calls).toBe(1)
    expect(Object.keys(added[0].models)).toHaveLength(catalogIds.length)
  })

  test("#given an editor that reports an existing provider #then user values win on install", () => {
    const added = []
    const editor = {
      get: () => ({ info: { name: "Existing Name" }, models: { "acme/custom": { name: "Custom" } } }),
      add: (entry) => added.push(entry),
    }
    const { context } = createTransformContext(editor)
    const transform = createOpenGatewayProviderTransform({ env: { [OPENGATEWAY_ENV_VAR]: "sk-x" }, readAuth: () => ({}), log: () => {} })

    transform.install(context)

    expect(added[0].info.name).toBe("Existing Name")
    expect(added[0].info.npm).toBe("@ai-sdk/openai-compatible")
    expect(added[0].models["acme/custom"]).toEqual({ name: "Custom" })
    expect(Object.keys(added[0].models)).toHaveLength(catalogIds.length + 1)
  })

  test("#given an editor without add but with a model setter #then every model is set", () => {
    const setModels = []
    const setInfo = []
    const editor = {
      set: (value) => setInfo.push(value),
      models: { set: (id, model) => setModels.push([id, model]) },
    }
    const { context, state } = createTransformContext(editor)
    const transform = createOpenGatewayProviderTransform({ env: { [OPENGATEWAY_ENV_VAR]: "sk-x" }, readAuth: () => ({}), log: () => {} })

    transform.install(context)

    expect(state.calls).toBe(1)
    expect(setInfo[0].info.name).toBe("OpenGateway")
    expect(setModels).toHaveLength(catalogIds.length)
  })

  test("#given a host without a provider transform #then install is a contained no-op", () => {
    const transform = createOpenGatewayProviderTransform({ env: { [OPENGATEWAY_ENV_VAR]: "sk-x" }, readAuth: () => ({}), log: () => {} })

    expect(() => transform.install({})).not.toThrow()
    expect(transform.install({})).toBeUndefined()
  })

  test("#given a transform that throws #then install contains the failure", () => {
    const logs = []
    const context = { provider: { transform: () => { throw new Error("editor blew up") } } }
    const transform = createOpenGatewayProviderTransform({ env: { [OPENGATEWAY_ENV_VAR]: "sk-x" }, readAuth: () => ({}), log: (entry) => logs.push(entry) })

    expect(() => transform.install(context)).not.toThrow()
    expect(logs.some((entry) => entry.event === "opengateway.install-failed")).toBe(true)
  })
})
