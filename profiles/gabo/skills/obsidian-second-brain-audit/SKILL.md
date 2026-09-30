---
name: obsidian-second-brain-audit
description: Use when the user asks to audit, review, or fix an Obsidian vault (or any folder of linked Markdown notes) so it works as a real "second brain" / neural-network of knowledge instead of a pile of disconnected files. Triggers on phrases like "revisa/audita mi bóveda", "que sea un segundo cerebro", "estructura de red neuronal", "audit my vault", "second brain", "PKM audit", "notes are not linked", "graph view has isolated dots", "MOC", "Zettelkasten structure". Also use for a follow-up pass on a vault this skill already touched, or to set up an ongoing linking convention so future notes stay connected. Do NOT use for generic file search, for editing note content unrelated to linking, or for non-Markdown knowledge bases.
---

# Obsidian Second-Brain Audit

Turns a folder of Markdown notes into a genuinely navigable knowledge network:
every note has an origin, a destination, and real peers — not just membership
in a pretty-looking graph. This skill is read-only until the user explicitly
approves a plan, and it only ever **adds** links; it never renames, moves, or
deletes user content unless the user explicitly asks for that separately.

This skill encodes real lessons from a full audit-to-execution cycle,
including two structural mistakes that were made and fixed. Do not repeat
them (see §5 and §6).

## 0. Scope and mode

- This is an audit-and-fix workflow, not a generic file operation. Treat the
  first pass on any vault as **read-only discovery**: locate the vault,
  measure it, report findings, and do not write anything until the user
  approves a plan — even if you are technically not in a plan-only harness
  mode.
- If multiple vaults exist on the machine (check for `.obsidian/` directories
  under common locations: `~/Documents`, `~/Desktop`, `~/Obsidian*`, and any
  path the user names), ask which one is in scope before touching anything.
- Default philosophy unless the user says otherwise: **additive only**. Never
  rename files, move files, delete files, or rewrite existing prose to make
  this work. The only mutations allowed by default are: (a) creating new
  index/MOC files, and (b) appending a links section to the end of existing
  notes. Confirm this default with the user early — some users want more
  (cleanup, deduplication, folder reorganization) and some want strictly
  nothing touched beyond links. Ask explicitly if unsure; do not assume.

## 1. Discovery (read-only)

Run the bundled script for the initial measurement instead of hand-rolling
one:

```
python3 <this-skill-dir>/scripts/audit_vault.py <vault_path>
python3 <this-skill-dir>/scripts/audit_vault.py <vault_path> --json
```

It reports, without modifying anything:
- total notes, outgoing links, notes with zero outgoing links
- fully isolated notes (no incoming AND no outgoing — the real problem)
- orphan notes (no incoming) and dead-end notes (no outgoing)
- broken wikilink targets
- duplicate basenames (these break Obsidian's wikilink resolution — `[[summary]]`
  is ambiguous if five files are named `summary.md`)
- connected components (a healthy vault converges to one dominant component;
  many single-note components means an archipelago, not a network)

Also do, by hand, before reporting:
- **Security scan.** Grep for credential-shaped content: connection URIs
  (`vless://`, `trojan://`, `wireguard://`, etc.), `password=`/`token=`/`api_key=`
  patterns, private key headers, SSH keys. If the vault syncs via a tool like
  Syncthing (`.stfolder`/`.stignore` presence) or is served by a local REST
  API plugin, flag this explicitly as a **security finding**, not a linking
  finding. Report it; do not silently fix it, and do not silently ignore it
  either — the user decides what to do with their own credentials on their
  own machine (do not lecture; state the fact and the exposure surface, then
  move on).
- **Vault hygiene scan.** Empty notes, double-extension files (`foo.md.md`),
  default template notes left over from Obsidian's first run (`Welcome.md` /
  `Bienvenido.md` containing `[[create a note]]`), tags that are actually
  false positives (hex colors, line numbers matched by a naive `#\w+` regex
  inside code blocks — filter code fences before counting tags).
- **False-positive filtering for "mentions".** When looking for plain-text
  mentions of a document name that could become a link, exclude anything
  inside backticks or fenced code blocks. Those are almost always literal
  file paths or shell snippets (e.g. `` `/home/user/vault/Master_Plan.md` ``
  inside a "tracked from" note) — wrapping them in `[[...]]` breaks the path
  as documentation and does not even render as a link inside code spans in
  Obsidian. Only convert mentions that sit in plain prose.

Report metrics plainly, in the numbers, before proposing anything. Do not
round up the state of the vault to sound better than it is.

## 2. Plan and explicit approval

Present a written plan and get explicit approval before writing anything.
The plan must state, concretely:
- What gets created (index file, MOC files — one per major
  folder/category is a reasonable default, but match whatever categorization
  already exists in the vault instead of inventing a new one).
- What gets appended, and where (a "links" section — ask what heading the
  user's own language/notes use, e.g. `## Vínculos`, `## Links`, `## See also`
  — match the vault's existing language and voice instead of translating it).
- What gets repaired (only broken links with a real, unambiguous
  resolution target — never fabricate a link to something that doesn't
  exist, and never guess at an ambiguous duplicate; report both instead).
- What is explicitly out of scope (security remediation, moving/renaming
  files, deleting anything, merging vaults) unless the user asks for it.

Ask 2-4 concrete scoping questions if the vault has any of: a large
subfolder of exported/generated content that duplicates another location
(ask whether it should be linked in place or excluded), more than one vault
on the machine (ask whether to unify), or sensitive content found in the
security scan (ask whether to touch it at all — default to leaving it, per
§0).

## 3. Build the navigation layer

Only after approval. Typical shape (adapt names/depth to what the vault
already uses):

```
00_INDEX.md              — home: how to navigate, links to every MOC and to
                            the main hub document(s)
00_MOCs/ (or similar)
├── MOC_<Category A>.md  — links every note in that category
├── MOC_<Category B>.md
└── ...
```

- The index and MOCs are new files — zero risk to existing content.
- Identify the vault's actual hub document(s) (a master plan, a running
  session log, a project overview — whatever the user's own workflow treats
  as the source of truth) and give it/them a links section listing what
  derives from it. A 400KB master plan with zero outgoing links is the most
  common single finding in an unlinked vault; fixing it is high-value.
- For every other significant document, add a "where this comes from"
  backlink to its parent/hub, appended at the end, never touching the
  original body.
- Idempotency: before appending a links section to any file, check whether
  it already has one (search for the exact heading you're about to use) and
  skip if present. Re-running this skill on an already-audited vault must
  not create duplicate sections.

## 4. Cross-link by real identity, not just by category

**This is the step most likely to be skipped, and skipping it produces a
vault that looks connected in the graph view but isn't.** A first pass that
only links every note to its category's shared index (memory notes → memory
index, evidence notes → evidence index) produces two or more dense,
disconnected star-clusters — visually "networked," functionally still two
piles. See §5 for what this looks like when done wrong.

Before finishing, actively search for notes across different categories that
document the **same real thing** — the same task ID, phase number, ticket,
date, or project name embedded in their filenames or frontmatter — and link
those pairs directly to each other, not only through the shared index.
Concretely:
- Extract identifier tokens from filenames on both sides (e.g. phase/task
  numbers like `23-6-5b`, ticket IDs, dates).
- Match tokens across categories (a "memory"/summary note and a
  "raw evidence"/export note about the same task are a textbook match).
- For each match, add a direct link in both directions.
- It is fine, and expected, for most raw/generated content to have no match
  — report that honestly as a structural fact of the project (more evidence
  was generated than was ever curated into a summary), not as something to
  paper over with a fabricated link.

## 5. Verify, don't just report metrics — look at the graph

After execution, re-run the discovery script and compare before/after
numbers. But metrics can lie: a vault can hit "0 isolated notes" while still
being two disconnected star-clusters bridged by only 2-3 thin links, which
looks wrong the moment the user opens Obsidian's graph view. If the user
reports the graph "looks like two separate blobs," that is real signal, not
an aesthetic complaint — go back to §4 and add real cross-links; do not
argue that the metrics already say "0 isolated." Functional navigability
(can a human or the agent actually trace "this comes from this, connects to
this") is the goal, not a round-looking graph.

## 6. Leave a standing verifier behind

Copy `scripts/audit_vault.py` into `<vault>/.tools/audit_vault.py` (create
the folder if needed). The script self-locates when run with no arguments
from inside a `.tools/` folder, so from then on the user (or any future
agent session) can just run:

```
python3 .tools/audit_vault.py
python3 .tools/audit_vault.py --new <path/to/new/note.md>
```

This turns "please remember to keep linking things" into something checkable
with a command, which is the only way the discipline survives past this
session.

## 7. Offer to make the convention durable (ask first, don't assume)

If the user has an existing agent-governance setup for the project the vault
belongs to (custom skills, standing rules, a session-start/closure protocol),
offer — do not silently do it — to encode a permanent rule there:
- The rule must apply at note **creation** time, not only at closure time.
  If the only integration point is a "task closure" skill, the rule will be
  silently skipped every time the user asks for a new roadmap/plan/design
  mid-task instead of at closure — broaden the trigger explicitly to cover
  "create/write/expand a roadmap, plan, design, or any vault document," not
  just "closing a task."
- The rule should reference the standing verifier from §6 by exact path/
  command, so it is enforceable, not just written down as a reminder.
- Write a companion memory/rule note in whatever format the project already
  uses for agent rules (match its existing style exactly — do not invent a
  new format), explaining the two failure modes from §4/§5 so future
  sessions don't reintroduce them.
- If no such governance setup exists, do not create one uninvited — mention
  the option and let the user decide.

## Common failure modes to avoid (learned the hard way)

1. **Linking only to a shared index.** Produces disconnected star-clusters.
   Fix: §4, real cross-links by shared identity.
2. **Converting mentions inside backticks/code to wikilinks.** Breaks literal
   file paths and shell snippets. Fix: only touch plain prose (§1).
3. **Treating hex colors / line numbers in code blocks as tags.** Strip
   fenced code before scanning for `#tag`-shaped tokens.
4. **Fabricating a link to a plausible-sounding but nonexistent target.**
   Only repair broken links with a real, unambiguous resolution; otherwise
   report them as unresolved.
5. **Renaming or moving files "to clean up" without being asked.** Default
   is additive-only (§0). Ask before doing anything else, even if it seems
   like an obvious improvement.
6. **Treating the linking rule as a closure-time-only concern.** It must
   trigger on note creation generally — a new roadmap or plan requested
   mid-task is exactly the same moment the rule must apply (§7).
7. **Declaring success from metrics alone.** "0 isolated notes" is necessary
   but not sufficient — check the actual shape of the graph and whether a
   human can trace a real chain end to end (§5).

