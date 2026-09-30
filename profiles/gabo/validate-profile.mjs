import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(fileURLToPath(import.meta.url))
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), "utf8"))
const fail = (message) => {
  console.error(`gabo profile validation failed: ${message}`)
  process.exit(1)
}

const omo = readJson("omo.jsonc")
const manifest = readJson("integration-manifest.json")
const opencode = readJson("opencode/opencode.json")
const profile = omo.profiles?.gabo?.["[opencode]"]

if (!profile) fail("profiles.gabo.[opencode] is required")
const expectedAgentDefinitions = [
  "__OMO_PROFILE_ROOT__/opencode/agents/forja.md",
  "__OMO_PROFILE_ROOT__/opencode/agents/juez.md",
]
if (JSON.stringify(profile.agent_definitions) !== JSON.stringify(expectedAgentDefinitions)) fail("Forja and Juez definition paths must remain portable templates")
if (profile.websearch?.provider !== "tavily") fail("websearch must use Tavily")
if (!profile.disabled_mcps?.includes("context7")) fail("OmO Context7 must be disabled")
if (profile.browser_automation_engine?.provider !== "playwright") fail("Playwright must be canonical")
if (profile.goal?.enabled !== false || profile.default_mode?.goal !== false) fail("OmO root Goal must stay disabled")
for (const hook of ["goal", "compaction-context-injector", "compaction-todo-preserver"]) {
  if (!profile.disabled_hooks?.includes(hook)) fail(`OmO ${hook} must be disabled to preserve the external root authority`)
}
if (profile.sisyphus_agent?.disabled !== true) fail("Sisyphus must not be the primary orchestrator")
if (!profile.disabled_skills?.includes("dev-browser") || !profile.disabled_skills?.includes("ultimate-browsing")) fail("conflicting browser skills must be disabled")
if (manifest.rootAuthorities?.orchestrator !== "forja") fail("Forja must be the root orchestrator")
if (manifest.rootAuthorities?.acceptance !== "juez") fail("Juez must be the acceptance authority")
if (!manifest.requiredPlugins?.includes("oc-codex-multi-auth")) fail("oc-codex-multi-auth is required")
if (opencode.default_agent !== "forja") fail("Forja must be the default agent")
if (opencode.plugin?.length !== 1 || !opencode.plugin[0].includes("__OMO_PLUGIN_ENTRY__")) fail("plugin entry must remain an explicit test-time placeholder")

const profileSerialized = JSON.stringify({ omo, opencode })
if (/WatchdogVPN|\/home\/gabodev|TAVILY_API_KEY|OPENAI_API_KEY|CODEX_AUTH/i.test(profileSerialized)) fail("profile contains a project rule, personal path, or secret marker")
if (!manifest.nonGoals?.includes("copy WatchdogVPN skills or commands")) fail("WatchdogVPN exclusion must remain explicit")

console.log("gabo profile validation passed")
