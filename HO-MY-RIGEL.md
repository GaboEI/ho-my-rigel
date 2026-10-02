# Ho My Rigel

**Ho My Rigel** is a community fork of
[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent), adapted
for the **OpenCode V2** plugin runtime. It is named after Rigel, the blue
supergiant in Orion.

It is **not** a fork or distribution of OpenCode itself. OpenCode remains an
external, normally updatable dependency. Rigel is the orchestration,
skills, MCP policy, agent and plugin ecosystem that runs on top of it.

## Why this fork exists

The upstream OpenCode harness integration was written around the V1 plugin
contract. OpenCode V2 replaces that contract with `setup()` and runtime
domains for tools and session hooks. A V1 module can appear to load in V2 yet
silently lose its tools or lifecycle behavior. Rigel makes that boundary an
explicit migration target rather than hiding it behind a compatibility claim.

## Current V2 migration status

Verified on OpenCode `v2.0.20`:

- V1-generated OmO agents are materialized as static V2 agents, because V2
  does not allow a plugin to add agents during `setup()`.
- Sisyphus is the main orchestrator and delegates by default.
- The V2 bridge registers the 13 current OmO tools, including `task`,
  `background_output`, `background_cancel`, `call_omo_agent`, `skill`, and
  `skill_mcp`.
- The bridge maps V1 pre/post tool hooks plus prompt, system-context and
  compaction hooks into the corresponding V2 registrations.
- `judge` is the single separate, non-editing acceptance agent. It packages
  the generic core of Gabo's Juez methodology, adapted from the former local
  definition to Rigel terminology; project-specific rules are excluded.
  Migration archives the prior local definition and prevents duplicate agent
  discovery. Momus remains a plan critic; it is never an alias or replacement
  for Judge.

The following V1 surfaces do not yet have a verified V2 mapping and are
reported at plugin startup instead of being silently claimed as active:

- `chat.headers`, `chat.params`, `command.execute.before`, `config`, `event`
- `experimental.chat.messages.transform`,
  `experimental.compaction.autocontinue`, `tool.definition`

This is intentionally an early community migration branch, not a statement
that upstream OmO V1 behavior has been fully ported. Every newly mapped
surface needs a real isolated OpenCode V2 proof before it is considered done.

## Design principles

- Keep OpenCode official and upgradeable.
- Keep model-authentication plugins and user-owned connections out of the
  forked profile; the profile declares integration policy, not credentials.
- Preserve one canonical provider per capability: Tavily for web search,
  external singleton Context7 and Playwright, and one protective SSH MCP.
- Keep external Goal and Context Mode as the root continuity/compaction
  authorities; Rigel coordinates delegated work beneath them.
- Package portable skills and agent governance, never project-specific rules
  or private infrastructure.

## Local development

The portable profile and the V2 bridge live under
[`profiles/gabo`](profiles/gabo/README.md). Its profile validator is:

```bash
node profiles/gabo/validate-profile.mjs
bun test profiles/gabo/opencode/omo-v2-adapter-core.test.mjs profiles/gabo/opencode/rigel-v2-native-*.test.mjs
node profiles/gabo/qa-v2-agent-transform-contract.mjs
node profiles/gabo/qa-v2-chat-message-contract.mjs
node profiles/gabo/qa-v2-system-transform-contract.mjs
node profiles/gabo/qa-v2-legacy-session-facade-contract.mjs
node profiles/gabo/qa-v2-native-delegation.mjs
```

Each contract command starts a real OpenCode V2 process with temporary `HOME`
and XDG directories. They do not modify the active OpenCode service or session
database. Evidence is written under ignored `.omo/evidence/`.

## Upstream, attribution and license

Rigel preserves upstream notices and is a modified derivative of Oh My
OpenAgent. The repository is under the upstream Sustainable Use License;
redistribution must remain free/non-commercial and retain the applicable
license and copyright notices. The Rigel modifications are marked in history
and documentation.
