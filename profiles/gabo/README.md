# Gabo profile kit

This kit is a portable configuration template for Ho My Rigel, the personal OmO fork. It is inert until a future installer copies its files into an **isolated** OpenCode/XDG environment and activates `OMO_PROFILE=gabo`.

It is deliberately not an installer. It contains no credentials, local host paths, accounts, model catalog, SSH targets, database settings, or WatchdogVPN rules.

## Layout

- `omo.jsonc` defines the OmO `gabo` profile: Tavily, one external Context7, external Goal ownership, Forja over Sisyphus, and canonical Playwright.
- `opencode/agents/` contains the portable Forja and Juez definitions.
- `opencode/opencode.json` is a test template. The runner substitutes `__OMO_PLUGIN_ENTRY__` with the local plugin entrypoint; it must never be copied unchanged to a user configuration.
- `integration-manifest.json` documents the external plugins and MCP ownership that a later isolated harness must provide.

## Validation

Run `node profiles/gabo/validate-profile.mjs`. It validates the static integration contract and rejects personal paths, secret markers, WatchdogVPN content, a duplicate OmO Context7, a competing OmO root goal, and a non-placeholder plugin path.

Run `bash profiles/gabo/run-v2-isolated.sh` to boot the host OpenCode **V2** binary against a disposable Docker home and XDG tree. The runner copies only this kit, mounts the fork source read-only, starts an authenticated local server, verifies the V2 OpenAPI surface plus the selected profile and agent definitions, and removes the sandbox on exit. It does not mount or read the active OpenCode configuration.

## Activation for a future isolated test

The test runner will create a temporary home, copy `omo.jsonc` as `<temporary-home>/.omo/omo.jsonc`, expand the portable agent-definition root only inside the container, copy the OpenCode template, substitute the local plugin entrypoint, and set `OMO_PROFILE=gabo`. It will never use Gabo's real configuration directory.
