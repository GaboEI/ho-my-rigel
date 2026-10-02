# Ho My Rigel fork guide

Ho My Rigel is a maintained community fork of
[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent). It rebuilds
the OmO OpenCode integration natively on the OpenCode V2 `setup()` plugin
runtime, with no V1 bridge at runtime: the upstream plugin serves only as a
build-time and test-time reference (agent manifest generation, differential
oracles). OpenCode remains an independently installable and updatable
dependency.

## What Rigel adds

- A single native V2 runtime (`profiles/gabo/opencode/rigel-v2-native.mjs`)
  that registers the selected OmO agents through `agent.transform` and
  `agent.reload`, delegates through the native `rigel_task` tool, and injects
  roster/ultrawork context at the `http.request` boundary. No agent
  definitions are written into OpenCode configuration.
- An isolated single-runtime invariant: the retired V1 bridge and legacy
  activation paths are quarantined under `profiles/gabo/attic/`; profile
  validation fails if any active file references them.
- A single integrated `Judge` acceptance auditor, based on the generic core
  of the original Gabo workflow and separated from project-specific rules.
- A portable profile kit covering agent governance, skill policy, MCP
  singleton ownership, and isolated acceptance checks.

The current V2 migration boundary is tracked row by row in
[profiles/gabo/V2_MIGRATION_INVENTORY.md](profiles/gabo/V2_MIGRATION_INVENTORY.md):
`Migrado`, `Migrado parcialmente`, `Incompatible (con evidencia)` and pending
rows each carry their own proof. Do not treat an unverified row as migrated.

## Supported setup model

Rigel is currently installed from a source checkout. It requires OpenCode V2
(verified against 2.0.22), Bun, and Node.js; the isolated QA contracts spawn
the V2 binary with a temporary HOME/XDG sandbox and a deterministic fake
provider. Docker is only needed by the heavier lab runners. Start with:

```bash
node profiles/gabo/validate-profile.mjs
bun test profiles/gabo/opencode
node profiles/gabo/qa-v2-lab-install-contract.mjs
node profiles/gabo/qa-v2-agent-transform-contract.mjs
node profiles/gabo/qa-v2-native-delegation.mjs
bash profiles/gabo/run-v2-isolated.sh
bash profiles/gabo/run-delegation-e2e.sh
```

The `gabo` profile is a reference integration kit, not a credential installer.
It deliberately excludes account pools, keys, hosts, database connections,
and project-local rules. It preserves existing model-authentication plugins and
the Obsidian MCP connection through fingerprint checks during the controlled
runtime refresh.

## Runtime refresh safety

Activate only after taking a configuration freeze and only with the isolated
V2 lab instance stopped. The refresh validates protected configuration,
generates the native agent manifest, updates the V2 runtime, then restarts the
service. `Judge` is registered from Rigel's manifest alongside the other
selected agents; it does not remove or rewrite a locally discovered user file.
The stable V1 installation (`~/.local/bin/opencode`, port 4096) is never
touched by Rigel tooling.

## License and attribution

This repository is a derivative of OmO. The inherited code remains under the
upstream [Sustainable Use License 1.0](LICENSE.md), which restricts use and
distribution to free, non-commercial purposes. It is **not** an OSI-approved
open-source license, and this fork cannot unilaterally change that fact.

Rigel-specific original additions are separately offered under the MIT License
in [LICENSE-RIGEL-ADDITIONS.md](LICENSE-RIGEL-ADDITIONS.md). That permission
does not grant rights to the inherited OmO code or turn the combined work into
an MIT-licensed project. See [NOTICE-RIGEL.md](NOTICE-RIGEL.md).