# Web data source (W2)

Single source of truth for the public Oh My Rigel web. The site (W5/W6) is
generated from these files; product data is never written by hand into pages.
This directory is established by phase W2 and consumed by W5 (generator), W6
(content) and W7 (publication gates).

## Format and location decision

**Format: JSON plus a JSON Schema.** Criteria: this repo already keeps all
machine-consumed data as JSON (`assets/*.schema.json`, `packages/web/messages/*.json`,
`.omo/fixtures/releases.json`); YAML is used only for CI/tooling config and is not
read by app code. JSON needs no new dependency, resolves natively in Bun/TS
(`resolveJsonModule`), and serializes canonically for hashing (the anti-drift
seal). Long Spanish prose is valid JSON strings.

**Location: `web/` at the repository root.** Criteria: the web workstream is a
first-class product, and `packages/web` is the unrelated OmO marketing site (its
own `package.json`, `bun.lock` and prettier/biome CI, excluded from the root test
runner). Placing the canonical source there would couple it to a site that
W8 reworks. A root `web/` keeps the source independent, is discovered by the
root `bun test` (so validation runs in the main CI), and leaves W5/W6 a stable
home. **Handoff to W5:** the site generator may live under `web/` (for example
`web/site/`) and MUST consume `web/data/`; it does not redefine this data.

## Files

- `data/schema/source.schema.json`: normative JSON Schema (draft 2020-12).
- `data/schema-validate.mjs`: JSON Schema interpreter used by the suite to
  validate every document against `source.schema.json` (no runtime dependency).
- `data/catalog.json`: 14 areas A-N and the 107 functions, migrated 1:1 from the
  approved catalog, each with the full contract fields below.
- `data/agents.json`: the published agent roster with mode, default state,
  default-state provenance, default model, required providers and behavior
  without them.
- `data/chains.json`: ordered model fallback chains per agent and per category.
- `data/cli.json`: the real command surface with ownership and the mandatory
  warnings.
- `data/seal.json`: version seal and the data hash (see anti-drift).
- `data/seal-lib.mjs`: canonical serialization and hash, shared by the builder
  and the test.
- `data/build-seal.mjs`: regenerates `seal.json` (`bun web/data/build-seal.mjs`).
- `data/source.test.ts`: the enforcing suite (schema, coverage, negatives, seal,
  anti-drift against the real product code).

## Required fields per function

Every function carries all of these, as required by the phase contract:

`id` (slug), `nombre`, `area` (A-N), `areaSlug`, `estado` (`activada` |
`desactivada` | `condicionada`), `v2` (`migrada` | `adaptada` | `reescrita` |
`sustituida` | `no_migrada` | `excluida`), `que_es` (what it does),
`como_se_usa` (how it is used), `cuando_sirve` (when it helps), `como_se_activa`,
`url`, `modo_de_activacion`, `requisitos`, `valores_por_defecto`, `ejemplos`,
`comandos`, `version_desde`, `cambios_relevantes`.

`modo_de_activacion` is the fixed "via" label the catalog cell starts with
(Automatico, Por chat, Palabra clave, Comando visible, Ajuste, Requisito externo,
Panel, Terminal, and their conditional variants). It is activation, not a
requirement.

The other six are contract fields. Each is an object `{procedencia, valor, fuente}`
when the catalog supplies the datum, or `{procedencia: "no_consta" | "no_aplica",
razon, fuente}` when it does not. `fuente` is always present. Nothing is invented:
an absent datum is declared absent with a reason, never filled with an activation
label or an inferred sentence.

### Contract field semantics (approved catalog to W2)

| Contract field | Meaning | Value source | When absent |
| --- | --- | --- | --- |
| `requisitos` | true external requirement (tool, service, credential, provider, installed language help) | catalog "Como se activa o condicion" for the 15 functions that declare one | `no_aplica` with reason (activation is automatic or via setting/keyword/command) |
| `valores_por_defecto` | default values or behaviors the catalog states beyond the on/off state | catalog cells with an explicit default (for example "por defecto solo informa") | `no_consta` with reason (the state lives in `estado`; no other default is declared) |
| `ejemplos` | the concrete scenario | catalog column "Cuando te sirve" | `no_consta`/`no_aplica` if empty |
| `comandos` | command tokens, resolved against the real CLI | catalog "Como la usas" / "Como se activa" | empty array (no command) |
| `version_desde` | first version the function exists in | not fixed per function by the catalog | `no_consta` with reason (OMR V2 is a developer preview) |
| `cambios_relevantes` | concrete migration disposition | catalog "Como esta en V2" for rewritten, replaced-by-base, not-in-preview or removed, plus explicit notes | `no_consta` for migrated/adapted (no concrete change described) |

## Synchronization rule (binding for W5/W6/W7)

Any code change that adds, removes, renames, or alters the behavior, default
state, requirements or usage of a feature MUST update this source in the same
change. The owner of the change updates the relevant entry (and `agents.json` /
`chains.json` / `cli.json` when the product surfaces change) AND regenerates
`seal.json` in the same commit. A feature that reaches the product without an
entry here, or an entry without product backing, is a defect of the change, not
a documentation task for later.

## Anti-drift mechanism

The published site is always generated from a source sealed with the product
version it documents. `seal.json` records `productVersion`, `baselineCommit` and
`dataSha256` (sha256 over the canonical, sorted-keys serialization of
`catalog.json`, `agents.json`, `chains.json`, `cli.json`). Any data edit without
re-sealing changes the recomputed hash and fails `source.test.ts`. A stale or
missing seal is a build failure, never a warning.

The suite also re-derives the product data directly from the real code, so the
JSON cannot drift from the product: agent ids from
`packages/omo-opencode/src/config/schema/agent-names.ts`; agent modes parsed from
each factory; agent and category chains from
`packages/model-core/src/{agent,category}-model-requirements.ts`; agent default
states anchored to the V2 runtime (`profiles/gabo/v2-agent-selection.json`,
`profiles/gabo/opencode/rigel-v2-native-agents.mjs`,
`profiles/gabo/opencode/rigel-v2-native-hephaestus.mjs`); the parent CLI from
`packages/omo-opencode/src/cli/*`; the Rigel CLI from
`profiles/gabo/cli/commands/*.mjs`; the slash commands from the builtin-commands
source.

## W7 CI-check specification (implemented here, enforced in W7)

`data/source.test.ts` implements the gates; W7 wires them into the publication
pipeline and rejects the build when any fails:

1. Schema: `data/schema-validate.mjs` validates every document against
   `source.schema.json`, and negative probes (missing required field, out-of-range
   enum, unknown property) are rejected.
2. Coverage: exactly 107 functions across 14 areas; per-area counts match the
   approved summary; state totals match; the id fingerprint equals the oracle.
3. Missing/extra: the function id set equals the frozen coverage fingerprint, so
   a deleted or renamed function fails.
4. Duplicates: no duplicate `id` or `url`.
5. Contradictory states: `excluida`/`no_migrada` must be `desactivada`;
   `sustituida` must be `activada`; unknown states fail.
6. Nonexistent commands: every command token in a function's usage cell and in
   `comandos` resolves to a real surface (`omo ...`, `rigel-v2 ...`,
   `oh-my-openagent ...`, `/slash`).
7. Contract fields: every function carries `modo_de_activacion` and the six
   contract fields; `no_consta`/`no_aplica` carries a reason; `fuente` is present;
   `requisitos` is never a bare activation label; `valores_por_defecto` matches an
   explicit default marker; `cambios_relevantes` is a concrete disposition or
   `no_consta` for migrated/adapted.
8. Agent/model/chain divergence: `agents.json` and `chains.json` must equal the
   values re-derived from the product code.
9. Seal: the recomputed `dataSha256` equals `seal.json`; `productVersion` equals
   the repository version; `baselineCommit` and `sealedFiles` are current.

## Agent roster provenance (no invented count)

`agents.json.roster` records three distinct surfaces, each anchored to code:

- `publishedPublic` / `universalOmO` = 11 built-in agents
  (`packages/omo-opencode/src/config/schema/agent-names.ts`).
- `gaboProfileRegistered` = 12: the 11 plus the operator-local `judge`
  (`profiles/gabo/v2-agent-selection.json`, `profiles/gabo/apply-v2-agent-layer.mjs`).
- `senpiNativeBuiltins` = 7 native-engine subagents
  (`packages/senpi-task/src/agents/builtin/index.ts`).

Each agent also carries `defaultStateProvenance`, anchored to the V2 runtime: the
11 orchestrated agents register unconditionally in V2, while `hephaestus` is
conditional and is dropped from the roster when its gate fails (a connected
provider plus a supported GPT model), per
`profiles/gabo/opencode/rigel-v2-native-agents.mjs` and
`rigel-v2-native-hephaestus.mjs`. `roster.v2StateRule` and `roster.v2StateSources`
record the rule and its files.

`reason` is a derived field: it maps the real default model/variant to the
reason vocabulary of W1 §10.3 (a model selected at variant `off`/`low` for
search agents marks speed/cost; `high`/`max`/`xhigh` for reasoning agents marks
reasoning; a vision-capable chain marks vision). `reasonBasis` cites the
observable fact. It is marked `reasonDerived: true` and is not a literal product
field.

## Count reconciliation (107 and 225)

The approved catalog exposes 107 functions across 14 areas (A:15 … N:3). The
figure 225 is the catalog's canonical inventory of internal *surfaces*, which
the catalog states is kept apart in a private working matrix and counted inside
the 107 functions. That matrix is not part of the vault or the repository, so W2
covers the 107 public functions 1:1 and records the 225 as a sourced-but-not-
enumerable figure rather than a coverage target it can verify.

## Regeneration

```
bun web/data/build-seal.mjs      # after any data edit
bun test web/data/source.test.ts # verify schema, coverage, seal and anti-drift
```

## W5/W6 static site

Phase W5 added the publication generator under `web/site/`, and W6 completed
the public ES/EN content over that generator. It is a dependency-free Bun static
site, chosen after comparing Eleventy, Astro and MkDocs Material against the W5
criteria. The generator consumes `web/data/` and does not redefine or fork the
source.

Commands from the repository root:

```bash
bun run web:check   # build and verify W3 routing, absolute SEO URLs and W4 CSS guardrails
bun run web:build   # emit static files to web/site/dist/ (gitignored)
bun run web:preview # build and serve a local preview at http://127.0.0.1:4173/oh-my-rigel/
```

The initial public base path is `/oh-my-rigel/`; generated links and canonical
SEO URLs are serialized with that base path. The root generated page is a static
language-selection gateway, not a redirect. W6 catalogue and guide prose is
generated from the sealed ES source plus id-anchored EN overlays rather than
placeholder W5 text; interface labels and cover framing live in `render.mjs`
(`const UI`) and are guarded by render/check tests.

### Security, performance and privacy decisions

- One same-origin deferred script only (`assets/catalog.js`): it opens the
  deep-linked `<details>` and wires the reusable copy control. No inline JS, no
  third-party script, no `meta refresh`, no `window.location`; the only
  navigation is an explicit link. `check.mjs` fails the build on any other
  `<script>` tag or inline JS.
- No third-party read-time dependency: one same-origin stylesheet, self-hosted
  fonts, zero external subresources, no analytics, no cookies, no forms, no
  client storage. The site is fully readable with network access denied other
  than the origin.
- GitHub Pages cannot set custom response headers, so no CSP/`X-Content-Type-Options`
  header is available. The real mitigations are the single same-origin script and
  the absence of any external resource; a `Content-Security-Policy` meta tag is
  deferred until a dynamic surface exists (W7), where it becomes meaningful.
- Performance: single ~22 KB CSS file; no font fetch from a third party; only the
  latin subset of each face is shipped.

### Self-hosted fonts (W4 identity)

Newsreader (display/body) and IBM Plex Mono (code/labels) are self-hosted under
`web/site/assets/fonts/` with `@font-face` rules and `rel="preload"`. Both are
SIL OFL 1.1; the license texts and `PROVENANCE.md` (source URLs + sha256) ship
with the fonts. `check.mjs` asserts `@font-face` exists and that the CSS contains
no external font origin.

### Bilingual overlays (W3 mechanism, W6 coverage)

`web/data/i18n/catalog.en.json` and `web/data/i18n/guide.en.json` are the
id-anchored EN overlays over the W2/W6 source. The catalog overlay covers all 14
areas and every rendered field for the 107 functions; the guide overlay covers
the agent, skill and command prose rendered by the public guide. Both overlays
are listed in the seal (`SEALED_FILES`) so an unsealed edit fails the W2 suite;
`source.test.ts` asserts they are id-anchored and carry only translatable fields.

### Interaction components (W5)

- Reusable copy control: every command/value block and the agent prompt use one component where a
  two-sheets icon sits inside the same bordered row, right-aligned, with no visible label and no
  external button. Success swaps to a check icon and announces Copiado/Copied through a live
  region. Failure swaps to an error icon, marks the row with the error border and shows the same
  message as visible text inside the row, so the feedback never depends on colour alone; both
  states clear themselves. `assets/catalog.js` wires it and the exact text lives in `data-copy`.
- Two-route install at the start of the Install section: an agent-prompt block whose text is the
  canonical English prompt from `OH-MY-RIGEL.md` (byte-identical on ES and EN, pinned by
  `web/site/render.test.ts` and `check.mjs`) and a manual route with the real guide commands and an
  explicit working directory.
- Catalogue open state is distinguishable without relying on colour or the `+/-` glyph alone, and
  single-item definition rows never render empty grid tracks. Both are fail-closed in `check.mjs`.
- Contrast: `web/site/contrast.test.ts` resolves the palette tokens for both themes and enforces
  WCAG >= 4.5:1 text and >= 3:1 focus/indicator, including the visited state and both button states.

### GitHub Actions boundary (W7 publishes)

`.github/workflows/web-public.yml` builds and checks on PR/push to `v2-mirror`
and only uploads a Pages artifact (no `actions/deploy-pages`). The remote Actions
run is verified in the publication phase (W7); W5 records the static local
proof and does not claim a live green run.
