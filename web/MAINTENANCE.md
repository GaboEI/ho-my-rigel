# Oh My Rigel Web Maintenance

This policy keeps the published Oh My Rigel web guide synchronized with the repository and with the OpenCode V2 preview it documents.

Published site: <https://gaboei.github.io/oh-my-rigel/>

## Responsible Owner

The maintainer who changes a user-facing Rigel behavior owns the matching web maintenance work for that change. If a change has multiple authors, the pull request owner is responsible for making the source data, generated web, tests, and evidence agree before review.

## Same-Change Triggers

Update the web source in the same change when a product change affects any public behavior or instruction, including:

- an agent, skill, command, permission, model chain, provider requirement, default state, installation step, update step, rollback step, or troubleshooting path;
- a compatibility limit, security boundary, license or attribution statement, public URL, or contribution instruction;
- the source material consumed by `web/data/`, the rendered ES/EN guide, or the public README entry.

Do not defer a matching web update to a later documentation pass. A product change without matching web source, or a web entry without product backing, is a defect of that change.

## CI Tests

Run the web checks from the repository root for every web maintenance event:

```bash
bun test web/
bun run web:check
bun run web:build
```

These checks cover the sealed data source, rendered routes, link and command guards, contrast rules, and static build output. If a broader repository change touches OpenCode, Codex, Senpi, or another harness surface, run the additional QA required by the root `AGENTS.md` for that surface.

## ES/EN Editorial Review

Review both Spanish and English output before publication. The review must confirm that both locales preserve the same facts, limits, commands, installation paths, and attribution. Translations may use natural wording, but they must not add claims, remove warnings, or soften compatibility limits.

## Quarterly Link and Obsolescence Review

At least once per quarter, review the published site for:

- broken or redirected critical links;
- obsolete OpenCode V2 commands, provider instructions, model examples, and install steps;
- stale compatibility, license, attribution, and publication status statements;
- content that duplicates repository docs without adding public-reader value.

Record the result even when no change is needed.

## Evidence Per Event

Each maintenance event records reviewer-readable evidence with:

- what changed and why the web source had to change in the same cycle;
- commands run and their observed result;
- the ES/EN editorial review outcome;
- the published URL or local build path reviewed;
- any omitted check and the reason it was omitted.

Keep raw logs, credentials, private paths, and secret-bearing environment dumps out of committed files and public pull request text.

## Manual Rollback

If a published web change must be reverted, use the repository history and GitHub Pages workflow to return to a known-good commit or to re-run a known-good Pages deployment. Record the commit, workflow run, observed URL, and reason for the rollback.

No completed remote rollback drill is recorded in this policy. Until such a drill is explicitly authorized and recorded, treat rollback as a manual operator action that must be verified after it runs.
