import { existsSync, readFileSync } from "node:fs"
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
  "__OMO_PROFILE_ROOT__/opencode/agents/juez.md",
]
if (JSON.stringify(profile.agent_definitions) !== JSON.stringify(expectedAgentDefinitions)) fail("Juez definition path must remain a portable template")
if (profile.agents?.sisyphus?.prompt_append !== "file://__OMO_PROFILE_ROOT__/opencode/prompts/sisyphus-orchestration.md") fail("Sisyphus must receive its orchestration contract")
if (profile.agents?.juez?.mode !== "primary" || profile.agents.juez.permission?.edit !== "deny" || profile.agents.juez.permission?.task !== "ask") fail("Juez must remain an independent non-executing auditor")
if (profile.websearch?.provider !== "tavily") fail("websearch must use Tavily")
if (!profile.disabled_mcps?.includes("context7")) fail("OmO Context7 must be disabled")
if (profile.browser_automation_engine?.provider !== "playwright") fail("Playwright must be canonical")
if (profile.goal?.enabled !== false || profile.default_mode?.goal !== false) fail("OmO root Goal must stay disabled")
for (const hook of ["goal", "compaction-context-injector", "compaction-todo-preserver"]) {
  if (!profile.disabled_hooks?.includes(hook)) fail(`OmO ${hook} must be disabled to preserve the external root authority`)
}
if (!profile.disabled_skills?.includes("dev-browser") || !profile.disabled_skills?.includes("ultimate-browsing")) fail("conflicting browser skills must be disabled")
if (manifest.rootAuthorities?.orchestrator !== "sisyphus" || manifest.rootAuthorities?.orchestrationContract !== "sisyphus") fail("Sisyphus must own the merged orchestration contract")
if (manifest.rootAuthorities?.acceptance !== "juez") fail("Juez must be the acceptance authority")
if (!manifest.requiredPlugins?.includes("oc-codex-multi-auth")) fail("oc-codex-multi-auth is required")
if (manifest.mcpPolicy?.websearch !== "tavily" || !manifest.mcpPolicy?.omoBuiltinsDisabled?.includes("context7")) fail("MCP singleton policy must preserve Tavily and external Context7")
if (!manifest.mcpPolicy?.omoBuiltinsRetained?.includes("grep_app") || !manifest.mcpPolicy?.omoBuiltinsRetained?.includes("lsp")) fail("OmO grep_app and LSP must remain available")
for (const mcp of ["docker", "ssh"]) {
  if (!manifest.mcpPolicy?.bundledLocal?.includes(mcp) || opencode.mcp?.[mcp]?.type !== "local" || opencode.mcp[mcp].enabled !== true) fail(`${mcp} must remain a bundled enabled local MCP`)
}
for (const mcp of ["context7", "playwright", "obsidian"]) {
  if (!manifest.mcpPolicy?.coreExternalConnections?.includes(mcp)) fail(`${mcp} must remain a core per-machine connection`)
}
if (!manifest.mcpPolicy?.optIn?.includes("github") || !manifest.mcpPolicy?.optIn?.includes("postgres")) fail("GitHub and Postgres must remain opt-in MCPs")
if (!manifest.mcpPolicy?.quarantinedPendingReview?.includes("tide") || !manifest.mcpPolicy?.excluded?.includes("openrouter")) fail("Tide must remain quarantined and OpenRouter excluded")
for (const skill of ["prompt-master", "juez-tester", "juez-repo"]) {
  if (!manifest.skillPolicy?.gaboCore?.includes(skill)) fail(`${skill} must remain a core Gabo skill`)
}
for (const skill of manifest.skillPolicy?.bundled ?? []) {
  const skillPath = join(root, "skills", skill, "SKILL.md")
  if (!existsSync(skillPath) || !readFileSync(skillPath, "utf8").startsWith(`---\nname: ${skill}`)) fail(`${skill} must have a valid bundled SKILL.md`)
}
if (!existsSync(join(root, "skills", "obsidian-second-brain-audit", "scripts", "audit_vault.py"))) fail("obsidian-second-brain-audit must retain its audit script")
for (const skill of ["dev-browser", "ultimate-browsing"]) {
  if (!manifest.skillPolicy?.omoDisabled?.includes(skill)) fail(`${skill} must remain disabled in the Gabo profile`)
}
if (opencode.default_agent !== "sisyphus") fail("Sisyphus must be the default agent")
if (opencode.plugin?.length !== 1 || !opencode.plugin[0].includes("__OMO_PLUGIN_ENTRY__")) fail("plugin entry must remain an explicit test-time placeholder")

const profileSerialized = JSON.stringify({ omo, opencode })
if (/WatchdogVPN|\/home\/gabodev|TAVILY_API_KEY|OPENAI_API_KEY|CODEX_AUTH/i.test(profileSerialized)) fail("profile contains a project rule, personal path, or secret marker")
if (!manifest.nonGoals?.includes("copy WatchdogVPN skills or commands")) fail("WatchdogVPN exclusion must remain explicit")

console.log("gabo profile validation passed")
