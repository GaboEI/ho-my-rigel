# Oh My Rigel upstream maintenance

Oh My Rigel is a fork of OmO, not of OpenCode. OpenCode V2 remains independently updatable. Upstream changes are reviewed in a separate Git worktree before they can affect the maintained Rigel branch.

## One-time remote setup

After publishing the personal fork, keep its remote as `origin` and register the original project separately:

```bash
git remote add upstream https://github.com/code-yeongyu/oh-my-openagent.git
```

## Review an upstream revision

From the maintained Rigel checkout, run:

```bash
RIGEL_UPSTREAM_REMOTE=upstream RIGEL_UPSTREAM_REF=dev bash profiles/gabo/prepare-upstream-review.sh
```

The command refuses a dirty primary checkout, fetches only the named upstream ref, creates a timestamped review worktree, and performs a non-committed merge **there**. Conflicts and test failures remain contained in that worktree.

Run the complete isolated acceptance suite inside the review worktree:

```bash
bash profiles/gabo/run-all-isolated.sh
```

For an additional real-model delegation run, explicitly opt into the locally running OpenGo provider:

```bash
OH_MY_RIGEL_USE_OPENGO=1 bash profiles/gabo/run-delegation-e2e.sh
```

The legacy `HO_MY_RIGEL_USE_OPENGO` name is still accepted as an alias during the
identity transition; `OH_MY_RIGEL_USE_OPENGO` is canonical.

This command neither mounts the active OpenCode configuration nor copies credentials. It only uses the locally running provider selected by the operator.

## Accept or roll back

Accept only after conflicts are understood, the suite passes, and the profile contract still matches `profiles/gabo/integration-manifest.json`. Commit the reviewed merge in the review worktree, then merge that reviewed commit into the maintained Rigel branch.

To reject an update, discard the review worktree rather than resetting the maintained branch:

```bash
git worktree remove <review-worktree-path>
git branch -D <review-branch>
```

No active OpenCode settings, credentials, sessions, skill sources, database connections, SSH hosts, or user project files are changed by either path.
