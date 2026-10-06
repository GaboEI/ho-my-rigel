#!/usr/bin/env node
/**
 * Produces the authoritative migration ledger from the V1 source tree.
 * A V2 feature is not considered migrated until it is explicitly mapped here
 * and backed by an isolated V2 contract.
 *
 * The ledger has two distinct readings of "hook":
 *   1. The V1 directory inventory (capability migration tracking).
 *   2. The real runtime composition, derived from the composer return objects.
 * The runtime count is the authoritative one; the repository prose disagrees
 * with itself and is not used as a source.
 *
 * Every row also carries a migration classification (Migrar / Adaptar /
 * Equivale a builtin V2 / Interno de build / Excluido), a rationale and a
 * future-evidence token. Classifications are source-controlled under
 * profiles/gabo/migration-classifications/<section>.mjs so a regeneration can
 * never silently downgrade a row back to "pending".
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const srcRoot = path.join(root, "packages/omo-opencode/src")
const hooksRoot = path.join(srcRoot, "hooks")
const toolsRoot = path.join(srcRoot, "tools")
const output = path.join(root, "profiles/gabo/V2_MIGRATION_INVENTORY.md")
const classificationsDir = path.join(root, "profiles/gabo/migration-classifications")

const SURFACE_DIRS = ["features", "plugin", "agents", "mcp", "config", "cli"]

// The classification vocabulary. `SIN CLASIFICAR` is deliberately NOT in the
// allowed set: the structural test fails while any row carries it.
const ALLOWED_CLASSIFICATIONS = [
  "Migrar",
  "Adaptar",
  "Equivale a builtin V2",
  "Interno de build (sin superficie de runtime)",
  "Excluido (unwired upstream)",
]

// The migration-status vocabulary for an authored fragment entry. A row that
// omits `status` renders as "Pendiente de ejecución"; an authored status must be
// one of these exact values, so a fragment can never invent a status the test
// vocabulary does not know.
const ALLOWED_STATUSES = [
  "Migrado",
  "Migrado parcialmente",
  "Incompatible (con evidencia)",
  "Pendiente de ejecución",
  "unwired upstream",
]

// ---------------------------------------------------------------------------
// Classification data (source-controlled fragments)
// ---------------------------------------------------------------------------

// Each section maps to profiles/gabo/migration-classifications/<section>.mjs,
// whose default export is `{ "<row>": { classification, rationale, futureEvidence } }`.
async function loadClassifications(section) {
  const file = path.join(classificationsDir, `${section}.mjs`)
  if (!fs.existsSync(file)) return {}
  const mod = await import(pathToFileURL(file).href)
  const map = mod.default
  if (!map || typeof map !== "object") {
    throw new Error(`${file} must default-export a classification object`)
  }
  for (const [row, entry] of Object.entries(map)) {
    if (!ALLOWED_CLASSIFICATIONS.includes(entry.classification)) {
      throw new Error(`${section}:${row} has invalid classification "${entry.classification}"`)
    }
    if (!entry.rationale || !entry.futureEvidence) {
      throw new Error(`${section}:${row} needs a non-empty rationale and futureEvidence`)
    }
    if (entry.status !== undefined && !ALLOWED_STATUSES.includes(entry.status)) {
      throw new Error(`${section}:${row} has invalid status "${entry.status}"`)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

// One row per immediate surface of a subsystem directory: subdirectories, plus
// non-test TypeScript modules that are behavior surfaces. Test files, AGENTS.md
// prose, barrel `index.ts`, ambient declarations and type-only `types.ts` are
// not surfaces to classify. `zauc-*` directories are mock setup, not surfaces.
function surfaceEntries(directory) {
  if (!fs.existsSync(directory)) return []
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith("zauc-")) continue
    if (entry.name === "AGENTS.md") continue
    if (entry.isDirectory()) {
      result.push(entry.name)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue
    if (entry.name === "index.ts" || entry.name === "types.ts") continue
    result.push(entry.name.slice(0, -3))
  }
  return [...new Set(result)].sort()
}

function directoriesWithIndex(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("zauc-")) continue
    const nested = path.join(directory, entry.name)
    if (fs.existsSync(path.join(nested, "index.ts"))) result.push(entry.name)
  }
  return result.sort()
}

// ---------------------------------------------------------------------------
// Runtime hook composition, derived from the composer return objects
// ---------------------------------------------------------------------------

// The tier composers return a flat object whose keys are the wired hook slots.
// The keys are read back out of the literal, so the count follows the code.
const COMPOSERS = [
  { tier: "session", label: "Session", file: "plugin/hooks/create-session-hooks.ts" },
  { tier: "tool-guard", label: "Tool guard", file: "plugin/hooks/create-tool-guard-hooks.ts" },
  { tier: "transform", label: "Transform", file: "plugin/hooks/create-transform-hooks.ts" },
  { tier: "continuation", label: "Continuation", file: "plugin/hooks/create-continuation-hooks.ts" },
  { tier: "skill", label: "Skill", file: "plugin/hooks/create-skill-hooks.ts" },
]

// The tier return objects list every key uniformly, so which slots are gated by
// `team_mode.enabled` or `monitor.enabled` is not visible in the return object;
// the gating lives in the factory assignments. It therefore cannot be derived
// from the composer return value and is declared here, next to the tiers that
// own it. Keys are the composer return-object keys.
const TEAM_GATED = {
  "tool-guard": ["teamToolGating"],
  transform: ["teamModeStatusInjector", "teamMailboxInjector"],
}
const MONITOR_GATED = {
  transform: ["monitorStatusInjector"],
}

// Handlers wired directly on the OpenCode `event` hook by plugin/event.ts when
// team_mode is enabled. Derived from the team-session-events directory.
function teamEventHandlers() {
  const dir = path.join(hooksRoot, "team-session-events")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => name.slice(0, -3))
    .sort()
}

// Standalone handler entrypoints at the hooks/ top level. The remaining
// top-level .ts files are helpers or monitors of these five entrypoints, not
// handlers, so they are not enumerated as hooks.
const STANDALONE_HOOKS = [
  "bash-file-read-guard",
  "empty-task-response-detector",
  "preemptive-compaction",
  "session-notification",
  "tool-output-truncator",
]

// Transform hooks whose implementation lives under features/ instead of hooks/.
const FEATURE_TRANSFORM_HOOKS = [
  { feature: "btw-side", symbol: "btwSideContextInjector" },
  { feature: "context-injector", symbol: "contextInjectorMessagesTransform" },
]

// Reads the keys of the last top-level `return { ... }` object in a source file.
function returnObjectKeys(source) {
  const start = source.lastIndexOf("return {")
  if (start === -1) throw new Error("no return object literal found")
  const open = source.indexOf("{", start)
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) throw new Error("unbalanced return object literal")
  return source
    .slice(open + 1, end)
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part))
}

const runtimeTiers = COMPOSERS.map(({ tier, label, file }) => {
  const keys = returnObjectKeys(fs.readFileSync(path.join(srcRoot, file), "utf8"))
  const teamGated = new Set(TEAM_GATED[tier] ?? [])
  const monitorGated = new Set(MONITOR_GATED[tier] ?? [])
  for (const key of [...teamGated, ...monitorGated]) {
    if (!keys.includes(key)) {
      throw new Error(`gating key ${key} is not a ${tier} composer key`)
    }
  }
  return {
    tier,
    label,
    file,
    keys,
    base: keys.filter((key) => !teamGated.has(key) && !monitorGated.has(key)).length,
    team: keys.filter((key) => !monitorGated.has(key)).length,
    monitor: keys.filter((key) => !teamGated.has(key)).length,
    both: keys.length,
  }
})

const eventHandlers = teamEventHandlers()
const totalBase = runtimeTiers.reduce((sum, tier) => sum + tier.base, 0)
const totalTeam = runtimeTiers.reduce((sum, tier) => sum + tier.team, 0) + eventHandlers.length
const totalMonitor = runtimeTiers.reduce((sum, tier) => sum + tier.monitor, 0)
const totalBoth = runtimeTiers.reduce((sum, tier) => sum + tier.both, 0) + eventHandlers.length

// A hook directory that the runtime never wires is not a runtime hook. It is
// excluded from the wired count and marked as such in the inventory instead of
// being left pending.
const UNWIRED_UPSTREAM = new Set(["task-reminder", "ralph-loop"])

// ---------------------------------------------------------------------------
// Ledger rows
// ---------------------------------------------------------------------------

// Renders one classification-bearing row. Order of precedence:
//   1. unwired upstream (excluded, never a migration target);
//   2. an authored classification from the section fragment;
//   3. a classification derived from an already-registered migration status;
//   4. SIN CLASIFICAR (the structural test fails while any of these exist).
function renderRow(item, classMap, overrides = {}, unwired = new Set()) {
  if (unwired.has(item)) {
    const preserved = overrides[item]
    const retained = preserved
      ? ` Capacidad V2 relacionada (clasificación retenida en el generador): ${preserved.evidence}`
      : ""
    return `| \`${item}\` | Excluido (unwired upstream) | unwired upstream | No se cablea en la composición del runtime V1 upstream (no aparece en \`createHooks\`). No se cuenta entre los hooks cableados.${retained} | - |`
  }
  const authored = classMap[item]
  if (authored) {
    return `| \`${item}\` | ${authored.classification} | ${authored.status ?? "Pendiente de ejecución"} | ${authored.rationale} | ${authored.futureEvidence} |`
  }
  const override = overrides[item]
  if (override) {
    const classification = override.classification ?? "Migrar"
    const baseRationale = "Clasificación derivada del estado de migración ya registrado."
    const rationale = override.owner ? `Dueno: ${override.owner}. ${baseRationale}` : baseRationale
    return `| \`${item}\` | ${classification} | ${override.status} | ${rationale} | ${override.evidence} |`
  }
  return `| \`${item}\` | SIN CLASIFICAR | - | - | - |`
}

function classificationRows(items, classMap, overrides = {}, unwired = new Set()) {
  return items.map((item) => renderRow(item, classMap, overrides, unwired)).join("\n")
}

const hooks = [...directoriesWithIndex(hooksRoot), ...STANDALONE_HOOKS]
const tools = directoriesWithIndex(toolsRoot)
const modes = ["default Ultrawork", "keyword Ultrawork / ULW", "Hyperplan", "Team mode", "Goal", "continuations", "background-task handoff"]
const known = [
  ["Agentes seleccionados", "Migrado parcialmente", "`agent.transform` + `agent.reload`; falta auditar todos los modos y permisos", "`qa-v2-agent-transform-contract.mjs`"],
  ["Delegación nombrada", "Migrado parcialmente", "`rigel_task`; foreground, continuación y handoff básico en background probados; faltan paridad de categorías y la capa V1 de cola/reintento/deduplicación", "`qa-v2-native-delegation.mjs`"],
  ["chat.message", "Migrado parcialmente", "La superficie nativa V2 inyecta roster/ultrawork/directorio en la frontera http.request; la variante por turno es el muro documentado (evidencia histórica del puente en attic). Re-prueba nativa pendiente en Fase 4", "`rigel-v2-native-prompt.mjs`; `qa-v2-chat-message-contract.mjs` y `qa-v2-chat-message-variant-contract.mjs` (attic)"],
  ["Instrucciones por directorio", "Migrado", "El inyector nativo anexa el contexto de `AGENTS.md`/`README.md` aplicable al resultado de lectura V2 (walk-up con skipRoot, README raiz incluido, dedup, truncado y clear), y el `AGENTS.md` raiz se conserva antes del primer turno de Hephaestus", "`rigel-v2-directory-instructions.mjs`; `rigel-v2-directory-instructions.test.mjs`"],
  ["Continuidad de compactacion", "Migrado", "El contexto de compaccion (plantilla de 8 secciones + historial delegado) llega al pedido de resumen via el hook compaction mutando event.messages (A1 demostrado en 3 niveles: plugin hermetico, runtime nativo, lab vivo con captura cruda); la restauracion de agent/tools es equivalente al builtin V2 (Experimento B)", "`rigel-v2-native-compaction-context.mjs`; `qa-v2-compaction-hook-contract.mjs`; `.omo/evidence/20261006-t21-compaction/`"],
  ["Keyword detector", "Migrado", "Los cuatro tipos (`ultrawork`/`ulw`, team mode, `hyperplan` y el combo), el modo predeterminado, la supresion del combo, el enrutado por fuente, los filtros de configuracion (`disabled_keywords`/`enabled_expansions`) y la restauracion tras compactacion se portan en `rigel-v2-keyword-core.mjs` y `rigel-v2-native-keyword-seam.mjs`; el drive staged (14/14) prueba los cuerpos V1 end to end.", "`rigel-v2-keyword-core.mjs`; `rigel-v2-native-keyword-seam.mjs`; `.omo/evidence/20261005-task-20/t12-keyword-seam.md`"],
]

// Overrides are source-controlled instead of hand edits in the generated
// document.  A successful regeneration therefore cannot silently downgrade
// completed or partially-audited work back to "pending".
const hookOverrides = {
  "background-notification": { status: "Migrado parcialmente", evidence: "Suscripción V2 a eventos terminales y reanudación del padre; faltan cola, reintento y deduplicación del manager V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs`" },
  "edit-error-recovery": { status: "Migrado", evidence: "The native V2 replacement extracts the event text by shape (result.content, result.error, event.error, event.output) without requiring `status: completed`, so it fires on a real V2 editor failure, and appends the same recovery instruction to the mutable channel. Tested with real failure shapes and a directed mutation. `rigel-v2-native-recovery.mjs`; `rigel-v2-native-recovery.test.mjs`" },
  "hephaestus-agents-md-injector": { status: "Migrado", evidence: "Hephaestus pertenece al roster V2 (`v2-agent-selection.json` `orchestratedAgentIds`, fuera de `excludedOmOAgentIds`), por lo que la inyección del `AGENTS.md` raíz ya no depende de la exclusión del perfil: la primera petición de Hephaestus recibe el contexto raíz. El gate de proveedor/modelo (`rigel-v2-native-hephaestus.mjs`) decide si el agente se registra, con mensajes equivalentes a V1. `rigel-v2-native.mjs`; `rigel-v2-native-hephaestus.mjs`; `rigel-v2-native-hephaestus.test.mjs`; `qa-v2-agents-md-contract.mjs`; `v2-agent-selection.json`" },
  "task-resume-info": { status: "Migrado", evidence: "`rigel_task` devuelve `sessionID` en contenido y metadatos, acepta `task_id` y reutiliza el hijo V2 existente. Servidor V2 aislado comprobado en una segunda vuelta del padre. `rigel-v2-native-core.mjs`; `qa-v2-native-delegation.mjs`" },
  // Retained even though the hook itself is unwired upstream, so the V2 work
  // stays recorded if the hook is ever wired again.
  "task-reminder": { status: "Migrado parcialmente", evidence: "El reemplazo nativo cuenta diez herramientas no-task por sesión y anexa el recordatorio al resultado de la décima. V2 usa `rigel_task` en vez de la familia V1 `task_*`, por lo que el texto y el mecanismo de seguimiento se adaptan a la superficie disponible. La frontera mutable V2 y la lógica de conteo están probadas. `rigel-v2-native-reminders.mjs`; `rigel-v2-native-reminders.test.mjs`; `qa-v2-tool-after-result-contract.mjs`" },
  "think-mode": { classification: "Migrar", status: "Migrado", evidence: "El seam por turno es el hook `context` de V2 con `event.options`, demostrado en vivo con captura del body final del proveedor en DOS adaptadores reales: OpenAI (modelo loopback) recibe `reasoning_effort` desde `event.options.reasoningEffort`, y el adaptador Anthropic real de V2 (endpoint loopback, claude-opus-4-7) recibe `thinking: {type:'enabled', budget_tokens}` desde `event.options.thinking`; cada adaptador ignora la clave del otro. `rigel-v2-native-reasoning-options.mjs` porta el detector V1 (strips de bloques de codigo, lista multilingue), `isAlreadyHighVariant`, la banda `thinking`<->`reasoningEffort` y emite AMBOS carriers; `rigel-v2-native-prompt.mjs` lo cablea en el hook `context` sobre el ULTIMO mensaje de usuario (por mensaje; turnos no relacionados intactos, demostrado en vivo turn1=thinking/turn2=sin cambio en Anthropic, turn1=reasoning_effort/turn2=sin cambio en OpenAI). El gate `disabled_hooks` `think-mode` se honra via el manifiesto. `rigel-v2-native-reasoning-options.mjs`; `rigel-v2-native-reasoning-options.test.mjs`; `rigel-v2-native-prompt.mjs`; `qa-v2-reasoning-variant-mechanism.mjs`; `qa-v2-reasoning-anthropic.mjs`; `.omo/evidence/20261006-t23-think-variants/`" },
  "write-existing-file-guard": { status: "Migrado", evidence: "The native V2 guard blocks writing an existing file without a prior read in the same sessionID, consumes the authorization once and keeps the `overwrite`/`.omo` bypass. PROVEN LIVE against the real V2 `write` builtin in the authorized lab: a real session received `status:error` with `error.message=\"File already exists. Use edit tool instead.\"`. `rigel-v2-native-write-guard.mjs`; `rigel-v2-native-write-guard.test.mjs`; `.omo/evidence/20261004-phase4-task18-guards/lab/session-context.json`" },
  "non-interactive-env": { status: "Migrado", evidence: "El guard nativo V2 antepone el entorno no interactivo a Git en `tool.execute.before` con prefijos por tipo de shell (unix/csh/powershell/cmd, detección de Windows igual que V1 #3607). Un comando interactivo baneado produce la misma advertencia observable de V1 en el output del shell en vez de colgar la sesión (V2 no permite adjuntar un mensaje en `execute.before`). Un servidor V2 aislado probó la reescritura de `git` y la advertencia del comando baneado. `rigel-v2-native-noninteractive.mjs`; `rigel-v2-native-noninteractive.test.mjs`; `qa-v2-noninteractive-contract.mjs`" },
}
const toolOverrides = {
  "background-task": { status: "Migrado parcialmente", evidence: "Spawn y resultado en background verificados en laboratorio V2; faltan límites, cancelación y persistencia de V1. `rigel-v2-native-core.mjs`; `qa-v2-native-delegation.mjs`" },
}
const modeOverrides = {
  "default Ultrawork": { status: "Migrado parcialmente", evidence: "Inyección raíz predeterminada probada; falta restauración tras compactación. `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs`" },
  "keyword Ultrawork / ULW": { status: "Migrado parcialmente", evidence: "Alias `Ultraworker`/`ultrawork`/`ulw` llegan al proveedor V2 y no a hijos. `qa-v2-native-delegation.mjs`" },
  "background-task handoff": { status: "Migrado parcialmente", evidence: "Evento `session.execution.*` despierta al padre con resultado visible; faltan reintentos y handoff diferido V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs`" },
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

const compositionRows = runtimeTiers.map((tier) =>
  `| ${tier.label} | ${tier.base} | ${tier.team} | ${tier.monitor} | ${tier.both} | ${tier.keys.map((key) => `\`${key}\``).join(", ")} |`,
)

const classHeaders = "| Fila | Clasificación | Estado | Rationale | Evidencia futura |\n| --- | --- | --- | --- | --- |"

async function sectionRows(section, items, overrides = {}, unwired = new Set()) {
  const classMap = await loadClassifications(section)
  return classificationRows(items, classMap, overrides, unwired)
}

const surfaceSections = []
for (const name of SURFACE_DIRS) {
  const items = surfaceEntries(path.join(srcRoot, name))
  surfaceSections.push(
    `## Superficies \`${name}/\` (${items.length})`,
    "",
    classHeaders,
    await sectionRows(name, items),
    "",
  )
}

const hooksRows = await sectionRows("hooks", hooks, hookOverrides, UNWIRED_UPSTREAM)
const toolsRows = await sectionRows("tools", tools, toolOverrides)
const modesRows = await sectionRows("modes", modes, modeOverrides)

// Aggregate the classification counts so a run can prove the ledger is closed.
const allClassMaps = {}
for (const section of [...SURFACE_DIRS, "hooks", "tools", "modes"]) {
  allClassMaps[section] = await loadClassifications(section)
}
const authoredCount = Object.values(allClassMaps).reduce((sum, map) => sum + Object.keys(map).length, 0)

const document = [
  "# Rigel: inventario de migración V1 a V2",
  "",
  "> Estado: **no completado**. Este documento se genera desde las superficies reales de OmO V1. Ninguna fila marcada como pendiente puede presentarse como migrada.",
  "",
  "## Regla de aceptación",
  "",
  "Cada capacidad necesita: equivalente V2 identificado, prueba aislada contra OpenCode V2 real y evidencia de que no toca V1. Si V2 carece de API, la fila debe contener la incompatibilidad y la evidencia, no una simulación.",
  "",
  "## Vocabulario de clasificación",
  "",
  "Toda fila lleva una clasificación, un rationale y una evidencia futura (el contrato o la tarea que demostrará la equivalencia):",
  "",
  "- `Migrar`: se porta a la superficie nativa V2 (el enfoque V2 vive en el rationale).",
  "- `Adaptar`: existe un muro (API V2 ausente o distinta); se adapta con un enfoque propuesto, nunca se descarta.",
  "- `Equivale a builtin V2`: el builtin nativo de V2 cubre el comportamiento; se demuestra con una prueba de paridad.",
  "- `Interno de build (sin superficie de runtime)`: módulo de soporte que no expone comportamiento propio; viaja con la capacidad que lo consume.",
  "- `Excluido (unwired upstream)`: no se cablea en la composición del runtime V1 upstream; no es un objetivo de migración.",
  "",
  "Una fila sin clasificación se imprime como `SIN CLASIFICAR` y la prueba estructural del inventario falla mientras exista.",
  "",
  "## Resumen de superficies conocidas",
  "",
  "| Superficie | Estado | Alcance actual | Evidencia |",
  "| --- | --- | --- | --- |",
  ...known.map((row) => `| ${row.join(" | ")} |`),
  "",
  "## Composición de hooks en runtime (derivada del código)",
  "",
  `Recuento derivado de los objetos de retorno de los compositores, no de la prosa del repositorio. Cada cifra es un recuento de **slots cableados registrados por el compositor**, incluidos los slots condicionados por configuración; no es un recuento de hooks activos por defecto. Base (team off, monitor off): **${totalBase}**; solo team mode: **${totalTeam}**; solo monitor (team off): **${totalMonitor}**; team mode + monitor: **${totalBoth}**.`,
  "",
  "| Tier | Base (team off, monitor off) | team mode | monitor (team off) | team mode + monitor | Hooks cableados (claves del compositor) |",
  "| --- | --- | --- | --- | --- | --- |",
  ...compositionRows,
  `| Handlers de evento directos (\`plugin/event.ts\`) | 0 | ${eventHandlers.length} | 0 | ${eventHandlers.length} | ${eventHandlers.map((name) => `\`${name}\``).join(", ")} |`,
  `| **Total** | **${totalBase}** | **${totalTeam}** | **${totalMonitor}** | **${totalBoth}** | |`,
  "",
  "Handlers enumerados fuera del escaneo de directorios de `hooks/`:",
  "",
  "| Grupo | Handlers |",
  "| --- | --- |",
  `| Archivos sueltos en \`hooks/\` | ${STANDALONE_HOOKS.map((name) => `\`${name}\``).join(", ")} |`,
  `| \`hooks/team-session-events/\` | ${eventHandlers.map((name) => `\`${name}\``).join(", ")} |`,
  `| Transform hooks en \`features/\` | ${FEATURE_TRANSFORM_HOOKS.map((hook) => `\`${hook.feature}\`:\`${hook.symbol}\``).join(", ")} |`,
  "",
  `Hooks no cableados upstream, excluidos del recuento cableado: ${[...UNWIRED_UPSTREAM].sort().map((name) => `\`${name}\``).join(", ")}.`,
  "",
  `## Hooks V1 (inventario de directorios, ${hooks.length})`,
  "",
  classHeaders,
  hooksRows,
  "",
  `## Herramientas V1 (${tools.length})`,
  "",
  classHeaders,
  toolsRows,
  "",
  ...surfaceSections,
  "## Modos y flujos transversales",
  "",
  classHeaders,
  modesRows,
  "",
  "## Criterio de cierre",
  "",
  "Solo puede declararse la migración terminada cuando no existan filas `SIN CLASIFICAR`, todas las filas tengan clasificación, rationale y evidencia futura, y las pruebas V2 correspondientes pasen en el laboratorio aislado.",
  "",
].join("\n")

fs.writeFileSync(output, document, { mode: 0o600 })
process.stdout.write(JSON.stringify({
  output,
  hooks: hooks.length,
  tools: tools.length,
  modes: modes.length,
  classifications: {
    authored: authoredCount,
    allowed: ALLOWED_CLASSIFICATIONS,
  },
  runtime: {
    unit: "composer-slot",
    countsConfigGatedSlots: true,
    countsDefaultActiveOnly: false,
    base: totalBase,
    team: totalTeam,
    monitor: totalMonitor,
    teamAndMonitor: totalBoth,
  },
  surfaces: Object.fromEntries(SURFACE_DIRS.map((name) => [name, surfaceEntries(path.join(srcRoot, name)).length])),
}) + "\n")
