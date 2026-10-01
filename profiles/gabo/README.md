# Gabo profile kit

This kit is a portable configuration template for Ho My Rigel, a community
fork of OmO adapted for the **OpenCode V2** runtime. It is inert until a
future installer copies its files into an **isolated** OpenCode/XDG environment
and activates `OMO_PROFILE=gabo`. It does not fork, pin, or distribute
OpenCode itself.

It is deliberately not an installer. It contains no credentials, local host paths, accounts, model catalog, SSH targets, database settings, or WatchdogVPN rules.

## Layout

- `omo.jsonc` defines the OmO `gabo` profile: Tavily, one external Context7, external Goal ownership, Sisyphus as the merged orchestrator, and canonical Playwright.
- `opencode/prompts/sisyphus-orchestration.md` adds the delegation and acceptance contract to upstream Sisyphus. `opencode/agents/judge.md` packages Gabo's independent Juez methodology, adapted to generic Rigel terminology and materialized as the V2 `judge` agent. During migration, a former local `judge.md` is archived under Rigel state and removed from OpenCode discovery so there is one canonical Juez. Momus is a distinct plan critic, never a Juez alias.
- `opencode/omo-v2-adapter*.mjs` is the explicit V1-to-V2 runtime bridge. It ports verified tool, prompt, context and compaction surfaces; unsupported legacy surfaces are reported, not hidden.
- `skills/` bundles portable governance/support skills, the complete Obsidian writing/audit/CLI suite, `tui-design` with its references and starter templates, and `skill-creator` with its evaluation resources.
- `opencode/opencode.json` is a test template. The runner substitutes `__OMO_PLUGIN_ENTRY__` with the local plugin entrypoint; it bundles only the protective SSH MCP command. Docker remains an opt-in external MCP. It must never be copied unchanged to a user configuration.
- `integration-manifest.json` records the core per-machine connections (Context7, Playwright, and Obsidian), opt-in integrations (GitHub and Postgres), and the excluded/quarantined services.

## Validation

Run `node profiles/gabo/validate-profile.mjs`. It validates the static integration contract and rejects personal paths, secret markers, WatchdogVPN content, a duplicate OmO Context7, a competing OmO root goal, and a non-placeholder plugin path.

Run `bash profiles/gabo/run-v2-isolated.sh` to boot the host OpenCode **V2** binary against a disposable Docker home and XDG tree. The runner copies only this kit, mounts the fork source read-only, starts an authenticated local server, verifies the V2 OpenAPI surface plus the selected profile and agent definitions, and removes the sandbox on exit. It does not mount or read the active OpenCode configuration.

Run `bash profiles/gabo/run-delegation-preflight.sh` to execute that isolated smoke plus focused tests of OmO's real delegated-session engine. It proves session creation, synchronous routing, continuation metadata, and child-session permission isolation; it deliberately does not use a model provider or account.

Run `bash profiles/gabo/run-session-authority-preflight.sh` to verify that the Gabo profile preserves external Goal and Context Mode as root authorities while OmO retains delegated-child continuation.

Run `bash profiles/gabo/run-mcp-policy-preflight.sh` to validate singleton ownership, the embedded protective SSH MCP, and the absence of credentials or duplicate external MCP declarations.

Run `bash profiles/gabo/run-all-isolated.sh` for the full non-account acceptance suite. See [UPSTREAM-MAINTENANCE.md](UPSTREAM-MAINTENANCE.md) for the isolated upstream-review and rollback procedure.

For an already active Rigel trial, `sudo bash profiles/gabo/apply-v2-runtime-service.sh` refreshes the V2 bridge and the static agent layer in one service stop/start. It preserves the protected model-auth plugins and Obsidian MCP fingerprint; it refuses the change if either differs from the frozen trial state.

## Activation for a future isolated test

The test runner creates a temporary home, copies `omo.jsonc` as `<temporary-home>/.omo/omo.jsonc`, copies the OpenCode template, substitutes the local plugin entrypoint, and sets `OMO_PROFILE=gabo`. It will never use Gabo's real configuration directory.
