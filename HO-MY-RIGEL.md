# Ho My Rigel

Ho My Rigel is a community fork of
[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) focused on
bringing the OmO feature set to the OpenCode V2 plugin runtime. Rigel targets
OpenCode V2 exclusively. It is not a fork or distribution of OpenCode, which
remains an independent dependency.

## Feature-completeness before expansion

The first goal is the complete OmO experience on V2. The migration should
preserve agents, delegation, skills, permissions, tools, context handling, and
continuity rather than reducing those surfaces to make the port easier.

Rigel-specific improvements are welcome after the project has a compatible
base supported by repeatable tests and observable behavior. Until then, a
feature that has no demonstrated V2 equivalent is a migration gap, not an
optional simplification.

## V2 preview status

The repository contains an active V2 developer preview. Current work includes
native V2 agent registration, orchestration and delegation paths, permission
handling, model routing, and prompt or context integration. These capabilities
are useful foundations, but they do not establish feature-completeness on V2.

The preview has material limits:

- The complete set of OmO agents, tools, hooks, skills, configuration, context,
  and continuity behavior has not been demonstrated on V2.
- Some behavior is still being ported or needs broader integration testing.
- OpenCode V2 and its plugin API continue to evolve, so verified integrations
  may need adaptation as the host changes.
- The preview is not ready for production use.
- The source installation currently requires a POSIX shell, Git, Bun, Node.js,
  and an OpenCode configuration stored as JSON.

Do not use the upstream OmO install command as an installation method for this
V2 preview. It installs the upstream product described elsewhere in the main
README, not Ho My Rigel.

## Install and run the V2 preview

Rigel is only for OpenCode V2. The recommended path is a clean upgrade to V2,
followed by a source installation of Rigel. Do not keep OpenCode V1 active in
parallel: shared configuration, data, cache, plugin, or goal state can
contaminate V1. If you cannot identify the active OpenCode version and every
state path it uses, stop before installing Rigel.

### Agent-first route

Paste this prompt into Codex, OpenCode V2, or another coding agent:

```text
Install and run the Ho My Rigel V2 developer preview from its public source.

Safety requirements:
- Inspect the checkout, AGENTS.md files, repository rules, README.md,
  HO-MY-RIGEL.md, FORK.md, CONTRIBUTING.md, script/agent/setup.sh,
  profiles/gabo/validate-profile.mjs, profiles/gabo/apply-v2-agent-layer.mjs,
  profiles/gabo/switch-live-plugin-to-native-v2.mjs, and
  profiles/gabo/materialize-v2-skills.mjs before changing anything.
- Rigel targets OpenCode V2 only. Detect the installed OpenCode version and
  stop unless it is V2. If OpenCode must be updated, use the current official
  OpenCode installation method and verify the resulting version.
- Confirm that no OpenCode process is running and that this installation will
  not reuse an active V1 installation. Do not create a parallel V1/V2 setup.
- Discover the actual OpenCode V2 config, data, state, cache, plugin, skills,
  and goal-state paths on this machine. Do not assume paths, services,
  credentials, or package managers. Stop and ask for help if ownership or
  isolation is uncertain.
- Never print, copy, or commit credentials or private configuration.

Installation requirements:
1. Use the v2-mirror branch of https://github.com/GaboEI/ho-my-rigel.
2. Run script/agent/setup.sh to verify tools, install dependencies, and build.
3. Run node profiles/gabo/validate-profile.mjs.
4. Set RIGEL_V2_HOME to the confirmed V2 home, RIGEL_V2_CONFIG to the absolute
   path of the active V2 JSON config, and RIGEL_V2_LAB_ROOT to a dedicated
   Rigel state directory. The variable name is historical; do not create or
   require a laboratory or service.
5. With those explicit variables, run
   profiles/gabo/apply-v2-agent-layer.mjs and then
   profiles/gabo/switch-live-plugin-to-native-v2.mjs.
6. Verify that the V2 config registers the generated Rigel runtime, launch the
   normal OpenCode V2 command, and confirm that Rigel reports its native V2
   runtime as active. Do not claim unavailable features.

Report the detected OpenCode version, resolved non-secret paths, commands run,
checks passed, and remaining limitations. If any safety condition cannot be
demonstrated, do not install or launch anything; explain the blocker and ask
for help.
```

### Human route

This is the clean source installation currently implemented by the repository.
Run it from a POSIX shell. First close every OpenCode process and update the
existing OpenCode installation to V2 rather than keeping V1 and V2 side by
side.

1. Install or update OpenCode using its
   [official V2 installation method](https://opencode.ai/v2/docs#cli), then verify
   that the selected executable reports V2:

   Use the same installation method that owns your current OpenCode executable
   so the update does not create a second installation. For the official
   standalone installer, the commands are:

   ```bash
   curl -fsSL https://opencode.ai/v2/install | bash
   case "$(opencode --version)" in
     *v2.*) ;;
     *) echo "OpenCode V2 is required" >&2; exit 1 ;;
   esac
   if pgrep -af '[o]pencode'; then
     echo "Close every OpenCode process before installing Rigel" >&2
     exit 1
   fi
   ```

   Stop if you cannot determine whether a listed process belongs to an older
   installation.

2. Clone the preview branch and prepare the checkout:

   ```bash
   git clone --branch v2-mirror --single-branch https://github.com/GaboEI/ho-my-rigel.git
   cd ho-my-rigel
   script/agent/setup.sh
   node profiles/gabo/validate-profile.mjs
   ```

3. Identify the JSON configuration used by your OpenCode V2 installation. Set
   its absolute path explicitly. Do not continue if the file belongs to V1, is
   not JSON, or its ownership is uncertain.

   ```bash
   export RIGEL_V2_HOME="$HOME"
   export RIGEL_V2_CONFIG="/absolute/path/to/the/active-v2/opencode.json"
   export RIGEL_V2_LAB_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ho-my-rigel"
   test -f "$RIGEL_V2_CONFIG"
   ```

   `RIGEL_V2_LAB_ROOT` is a historical variable name. In this route it is only
   Rigel's state and generated-runtime directory; no laboratory or service is
   created.

4. Generate the V2 agent layer, install the native runtime into the selected V2
   config, then start OpenCode normally:

   ```bash
   node profiles/gabo/apply-v2-agent-layer.mjs
   node profiles/gabo/switch-live-plugin-to-native-v2.mjs
   opencode
   ```

The two Node scripts refuse missing prerequisites and preserve protected config
fingerprints. They materialize the selected agents and skills, stage the native
runtime under the dedicated Rigel state directory, and register that runtime in
the chosen V2 config. They do not update OpenCode itself.

This preview has no automated uninstaller. Keep the checkout available because
the generated runtime and skill links refer to its files. If any step fails,
stop and report the command and sanitized error instead of trying a different
config or running a second OpenCode installation.

## How to contribute

Contributors can help without treating the preview as finished:

- Port an OmO agent, tool, hook, skill, permission, or continuity surface to
  the V2 plugin API.
- Add tests for observable behavior on OpenCode V2.
- Exercise an existing V2 surface and report reproducible successes, failures,
  or host API changes.
- Review integrations for lost context, weakened permissions, or behavior that
  only appears to work because a module loads.
- Improve public documentation, examples, and migration notes while keeping
  maturity claims tied to reproducible behavior.

Start from the source installation above and choose a narrowly scoped
contribution. Open an issue or draft pull request describing the behavior you
are preserving, the V2 API surface you are using, and how another contributor
can reproduce the result. The [contribution guide](CONTRIBUTING.md) covers
repository-wide setup and pull request expectations.

## Developer reading path

1. Read this page for the product goal, preview status, and installation paths.
2. Read [FORK.md](FORK.md) for the fork boundary and license constraints.
3. Read [CONTRIBUTING.md](CONTRIBUTING.md) before preparing a change.
4. Use the upstream [OmO documentation](https://omo.dev/docs) to understand the
   feature being ported, then verify assumptions against this repository.

## Upstream, attribution, and license

Rigel preserves upstream notices and is a modified derivative of Oh My
OpenAgent. The inherited code remains under the upstream
[Sustainable Use License 1.0](LICENSE.md), which restricts use and distribution
to free, non-commercial purposes and is not an OSI-approved open-source
license. Rigel-specific original additions are separately offered under the
[MIT License](LICENSE-RIGEL-ADDITIONS.md), without relicensing inherited OmO
code. See [NOTICE-RIGEL.md](NOTICE-RIGEL.md) for the attribution boundary.
