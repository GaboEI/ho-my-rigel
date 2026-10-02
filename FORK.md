# Ho My Rigel fork guide

Ho My Rigel is a maintained community fork of
[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent). It adapts
the OmO OpenCode integration to the OpenCode V2 `setup()` plugin runtime.
It is not an OpenCode distribution: OpenCode remains an independently
installable and updatable dependency.

## What Rigel adds

- A V2 bridge for verified OmO tool and lifecycle surfaces.
- Native V2 registration for Sisyphus and its delegated specialists through
  `agent.transform` and `agent.reload`; no agent definitions are written into
  OpenCode configuration.
- A single integrated `Judge` acceptance auditor, based on the generic core
  of the original Gabo workflow and separated from project-specific rules.
- A portable profile kit covering agent governance, skill policy, MCP
  singleton ownership, and isolated acceptance checks.

The current V2 boundary and intentionally unsupported V1 hooks are documented
in [HO-MY-RIGEL.md](HO-MY-RIGEL.md). Do not treat an unsupported hook as
available merely because a legacy plugin module loads.

## Supported setup model

Rigel is currently installed from a source checkout. It requires OpenCode V2,
Bun, Node.js, and Docker for the isolated checks. Start with the non-account
suite:

```bash
node profiles/gabo/validate-profile.mjs
bun test profiles/gabo/opencode/omo-v2-adapter-core.test.mjs
node profiles/gabo/qa-v2-agent-transform-contract.mjs
node profiles/gabo/qa-v2-chat-message-contract.mjs
node profiles/gabo/qa-v2-legacy-session-facade-contract.mjs
node profiles/gabo/qa-v2-native-delegation.mjs
bash profiles/gabo/run-v2-isolated.sh
bash profiles/gabo/run-delegation-e2e.sh
```

The `gabo` profile is a reference integration kit, not a credential installer.
It deliberately excludes account pools, keys, hosts, database connections,
and project-local rules. It preserves existing model-authentication plugins and
the Obsidian MCP connection through fingerprint checks during the controlled
live trial.

## Live-trial safety

Activate only after taking a configuration freeze and only with OpenCode
stopped. The trial has a rollback path that restores the pre-Rigel snapshot.
The system-service wrappers are intentionally specific to the local trial
host; adapt them before using them on another machine.

Before applying any V2 refresh, close all OpenCode processes. The refresh
stops the service, validates protected configuration, generates the native
agent manifest, updates the V2 runtime, then restarts the service. `Judge` is
registered from Rigel's manifest alongside the other selected agents; it does
not remove or rewrite a locally discovered user file.

## License and attribution

This repository is a derivative of OmO. The inherited code remains under the
upstream [Sustainable Use License 1.0](LICENSE.md), which restricts use and
distribution to free, non-commercial purposes. It is **not** an OSI-approved
open-source license, and this fork cannot unilaterally change that fact.

Rigel-specific original additions are separately offered under the MIT License
in [LICENSE-RIGEL-ADDITIONS.md](LICENSE-RIGEL-ADDITIONS.md). That permission
does not grant rights to the inherited OmO code or turn the combined work into
an MIT-licensed project. See [NOTICE-RIGEL.md](NOTICE-RIGEL.md).
