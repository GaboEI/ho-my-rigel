# Ho My Rigel

**Ho My Rigel** is a community fork of
[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent), rebuilt
natively for the **OpenCode V2** plugin runtime. It is named after Rigel, the
blue supergiant in Orion.

It is **not** a fork or distribution of OpenCode itself. OpenCode remains an
external, normally updatable dependency. Rigel is the orchestration,
skills, MCP policy, agent and plugin ecosystem that runs on top of it.

## Why this fork exists

The upstream OpenCode harness integration was written around the V1 plugin
contract. OpenCode V2 replaces that contract with `setup()` and runtime
domains for tools and session hooks. A V1 module can appear to load in V2 yet
silently lose its tools or lifecycle behavior. Rigel therefore rebuilds the
product natively on V2: the upstream V1 plugin is used only as a build-time
reference for agent manifest generation and as a differential test oracle —
never at runtime.

## Architecture

- **One native runtime**: `profiles/gabo/opencode/rigel-v2-native.mjs` is the
  single plugin entrypoint. Agents register through `agent.transform` /
  `agent.reload`; delegation goes through the native `rigel_task` tool;
  roster/ultrawork/rules context is injected at the `http.request` boundary.
- **No bridge**: the former V1 adapter and every legacy activation path are
  quarantined under `profiles/gabo/attic/`; profile validation fails if any
  active file references them.
- **Verified rows, not claims**: the migration ledger
  ([profiles/gabo/V2_MIGRATION_INVENTORY.md](profiles/gabo/V2_MIGRATION_INVENTORY.md))
  tracks every V1 hook, tool and mode with its own isolated V2 proof.
  Verified against OpenCode `v2.0.22`.
- **Judge** is the single separate, non-editing acceptance agent, packaging
  the generic core of Gabo's Juez methodology; project-specific rules are
  excluded. Momus remains a plan critic; it is never an alias or replacement
  for Judge.
- **Two OpenCode installations, one rule**: the stable V1 installation
  (`~/.local/bin/opencode`, port 4096) is production and is never touched by
  Rigel tooling; the V2 lab (`~/.opencode/bin/opencode`, port 4097) is where
  Rigel installs, refreshes and is tested.

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

The native runtime and the portable profile live under
[`profiles/gabo`](profiles/gabo/README.md). Its validator is:

```bash
node profiles/gabo/validate-profile.mjs
bun test profiles/gabo/opencode
node profiles/gabo/qa-v2-agent-transform-contract.mjs
node profiles/gabo/qa-v2-native-delegation.mjs
node profiles/gabo/qa-v2-noninteractive-contract.mjs
bash profiles/gabo/run-v2-isolated.sh
```

Each contract command starts a real OpenCode V2 process with temporary `HOME`
and XDG directories and a deterministic fake provider. They do not modify the
active OpenCode service or session database, and they read the V2 lab binary
only. Evidence is written under ignored `.omo/evidence/`.

## Upstream, attribution and license

Rigel preserves upstream notices and is a modified derivative of Oh My
OpenAgent. The repository is under the upstream Sustainable Use License;
redistribution must remain free/non-commercial and retain the applicable
license and copyright notices. The Rigel modifications are marked in history
and documentation.