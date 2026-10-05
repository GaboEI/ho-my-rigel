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
    status: "Migrado",
    rationale:
      "La delegación nombrada V1 (`tools/call-omo-agent/tools.ts`) se adapta a la superficie nativa `rigel_task` de V2, que resuelve agentes por inventario y crea sesiones hijas con `session.create`/`session.prompt` en `rigel-v2-native-core.mjs`.",
    futureEvidence: "`rigel-v2-native.mjs` (rigel_task); `rigel-v2-native-flow-guards.mjs`; `qa-v2-native-delegation.mjs`",
  },
  "delegate-task": {
    classification: "Adaptar",
    status: "Migrado parcialmente",
    rationale:
      "El enrutado por categoría y subagente de `tools/delegate-task/tools.ts` se adapta al `rigel_task` nativo, que resuelve categorías y agentes llamables y delega con modelo por categoría en `rigel-v2-native.mjs`.",
    futureEvidence: "`rigel-v2-native-categories.mjs`; `rigel-v2-background-key.mjs`; `rigel-v2-native.mjs`",
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
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El editor por hashes de `tools/hashline-edit/tools.ts` se adapta al modelo de edición de V2 con `createHashlineEditTool` en `rigel-v2-native-hashline.mjs`, registrado como `hashline_edit`: valida el hash LINE#ID antes de escribir, restaura el envoltorio de BOM y CRLF, permite crear un archivo ausente con append o prepend sin ancla y rechaza el hash obsoleto sin tocar el archivo. El port de `hashline-core` vive en `rigel-v2-native-hashline-core.mjs` y su paridad con V1 está fijada por prueba.",
    futureEvidence: "`rigel-v2-native-hashline.mjs`; `rigel-v2-native-hashline-core.mjs`; `rigel-v2-native-hashline.test.mjs`",
  },
  "interactive-bash": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La shell interactiva por tmux de `tools/interactive-bash/tools.ts` se porta a la superficie nativa V2, condicionada a la detección de tmux disponible en el host.",
    futureEvidence: "`tools/interactive-bash.tools.mjs`; `rigel-v2-native-conditional-tools.mjs`; `rigel-v2-native-conditional-tools.test.mjs`",
  },
  "look-at": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El análisis multimodal de `tools/look-at/tools.ts` se porta a V2 con enrutado al agente multimodal-looker y el permiso runtime correspondiente.",
    futureEvidence: "`tools/look-at.tools.mjs`; `rigel-v2-native-tools.mjs`",
  },
  monitor: {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "La familia `monitor_start/stop/list/output` de `tools/monitor/create-monitor-tools.ts` se porta a V2, condicionada a la clave de configuración `monitor.enabled` (apagada por defecto).",
    futureEvidence: "gate:monitor.enabled",
  },
  "session-manager": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Las herramientas de sesión `session_list/read/search/info` de `tools/session-manager/tools.ts` se portan a V2 envolviendo el SDK nativo con la semántica V1 de dominio, paginación y formatos.",
    futureEvidence: "`tools/session.tools.mjs`; `rigel-v2-native-tools.mjs`",
  },
  skill: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La selección y carga de skills de `tools/skill/tools.ts` se porta a V2 con el descubrimiento por `SCOPE_PRIORITY` de skills-loader-core y la inyección real del cuerpo de la skill en el hijo delegado.",
    futureEvidence: "`rigel-v2-native-skills.mjs` (discoverSkills); `rigel-v2-native.mjs` (inyeccion de cuerpos en hijos delegados)",
  },
  "skill-mcp": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El MCP embebido en skill de `tools/skill-mcp/tools.ts` se porta a V2 como tier-3 con transporte stdio y HTTP y aislamiento por sesión.",
    futureEvidence: "`rigel-v2-native-skill-mcp.mjs`; `rigel-v2-skill-mcp-oauth.mjs`; `rigel-v2-skill-mcp-oauth.test.mjs`",
  },
  slashcommand: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El descubrimiento de comandos de `tools/slashcommand/command-discovery.ts` se migra a la herramienta nativa `slashcommand`, que lee el catalogo de comandos del host (`ctx.command.list()`), union de los comandos del runtime (`goal`, `ulw-execute`) y del host V2.",
    futureEvidence: "`tools/slashcommand.tools.mjs`; `tools/slashcommand.tools.test.mjs`; `rigel-v2-native.mjs`",
  },
  task: {
    classification: "Adaptar",
    status: "Migrado parcialmente",
    rationale:
      "La familia `task_create/get/list/update` de `tools/task/` se adapta al motor de tareas nativo de V2, con los gates de configuración respetados en runtime.",
    futureEvidence: "`tools/task.tools.mjs`; `rigel-v2-native-conditional-tools.mjs`; `tools/task.tools.test.mjs`",
  },
}
