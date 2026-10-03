/**
 * Clasificación de migración para las herramientas V1 de OmO.
 *
 * Cada fila mapea un directorio real bajo
 * `packages/omo-opencode/src/tools/<fila>/index.ts` a su destino en el
 * runtime nativo de OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs`
 * y `rigel-v2-native-core.mjs`). El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `tools` del ledger.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "call-omo-agent": {
    classification: "Adaptar",
    rationale:
      "La delegación nombrada V1 (`tools/call-omo-agent/tools.ts`) se adapta a la superficie nativa `rigel_task` de V2, que resuelve agentes por inventario y crea sesiones hijas con `session.create`/`session.prompt` en `rigel-v2-native-core.mjs`.",
    futureEvidence: "task:14",
  },
  "delegate-task": {
    classification: "Adaptar",
    rationale:
      "El enrutado por categoría y subagente de `tools/delegate-task/tools.ts` se adapta al `rigel_task` nativo, que resuelve categorías y agentes llamables y delega con modelo por categoría en `rigel-v2-native.mjs`.",
    futureEvidence: "task:17",
  },
  glob: {
    classification: "Equivale a builtin V2",
    rationale:
      "El builtin `glob` de V2 cubre la búsqueda por patrón de `tools/glob/tools.ts`; la equivalencia se demuestra con una prueba de paridad de comportamiento contra el builtin nativo.",
    futureEvidence: "contract:qa-v2-builtin-parity.mjs",
  },
  grep: {
    classification: "Equivale a builtin V2",
    rationale:
      "El builtin `grep` de V2 cubre la búsqueda por contenido de `tools/grep/tools.ts`; la equivalencia se demuestra con una prueba de paridad de comportamiento contra el builtin nativo.",
    futureEvidence: "contract:qa-v2-builtin-parity.mjs",
  },
  "hashline-edit": {
    classification: "Adaptar",
    rationale:
      "El editor por hashes de `tools/hashline-edit/tools.ts` se adapta al modelo de edición de V2: el read enhancer LINE#ID y un equivalente de `hashline_edit` con validación de hash sobre la superficie nativa.",
    futureEvidence: "task:19",
  },
  "interactive-bash": {
    classification: "Migrar",
    rationale:
      "La shell interactiva por tmux de `tools/interactive-bash/tools.ts` se porta a la superficie nativa V2, condicionada a la detección de tmux disponible en el host.",
    futureEvidence: "task:16",
  },
  "look-at": {
    classification: "Migrar",
    rationale:
      "El análisis multimodal de `tools/look-at/tools.ts` se porta a V2 con enrutado al agente multimodal-looker y el permiso runtime correspondiente.",
    futureEvidence: "task:15",
  },
  monitor: {
    classification: "Migrar",
    rationale:
      "La familia `monitor_start/stop/list/output` de `tools/monitor/create-monitor-tools.ts` se porta a V2, condicionada a la clave de configuración `monitor.enabled` (apagada por defecto).",
    futureEvidence: "gate:monitor.enabled",
  },
  "session-manager": {
    classification: "Migrar",
    rationale:
      "Las herramientas de sesión `session_list/read/search/info` de `tools/session-manager/tools.ts` se portan a V2 envolviendo el SDK nativo con la semántica V1 de dominio, paginación y formatos.",
    futureEvidence: "task:15",
  },
  skill: {
    classification: "Migrar",
    rationale:
      "La selección y carga de skills de `tools/skill/tools.ts` se porta a V2 con el descubrimiento por `SCOPE_PRIORITY` de skills-loader-core y la inyección real del cuerpo de la skill en el hijo delegado.",
    futureEvidence: "task:14",
  },
  "skill-mcp": {
    classification: "Migrar",
    rationale:
      "El MCP embebido en skill de `tools/skill-mcp/tools.ts` se porta a V2 como tier-3 con transporte stdio y HTTP y aislamiento por sesión.",
    futureEvidence: "task:14",
  },
  slashcommand: {
    classification: "Migrar",
    rationale:
      "El descubrimiento de comandos de `tools/slashcommand/command-discovery.ts` se migra al modelo de comandos de V2, conservando el descubrimiento por directorios y el frontmatter.",
    futureEvidence: "task:14",
  },
  task: {
    classification: "Adaptar",
    rationale:
      "La familia `task_create/get/list/update` de `tools/task/` se adapta al motor de tareas nativo de V2, con los gates de configuración respetados en runtime.",
    futureEvidence: "task:16",
  },
}
