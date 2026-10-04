/**
 * Clasificación de migración para los modos y flujos transversales de OmO V1.
 *
 * Cada fila mapea un modo del plan `migracion-espejo-v2-omr.md` (secciones de
 * team mode, goal y keyword detector) a su destino en el runtime nativo de
 * OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs`,
 * `rigel-v2-native-prompt.mjs` y `rigel-v2-native-core.mjs`). El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `modes` del ledger, junto con los overrides de estado que
 * cubren los modos ya parcialmente auditados.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  Hyperplan: {
    classification: "Adaptar",
    rationale:
      "La expansión de Hyperplan del keyword detector (sección de keyword detector del plan, hook `keyword-detector`) se adapta a la superficie de keywords de V2, que hoy solo reconoce Ultraworker/ultrawork/ulw; la expansión completa se cubre en la tarea 20.",
    futureEvidence: "task:20",
  },
  "Team mode": {
    classification: "Migrar",
    rationale:
      "El team mode completo (sección de team mode del plan, gate `team_mode.enabled`) se migra a V2 con sus herramientas, mailbox y ciclo de vida de miembros, sin recortes de alcance.",
    futureEvidence: "gate:team_mode.enabled",
  },
  Goal: {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "El modo Goal (sección de goal del plan, gate `goal.enabled`) se migra con `create_goal`, `update_goal` y `get_goal` portados a la superficie nativa de V2 como indica la tarea 16.",
    futureEvidence: "task:16",
  },
  continuations: {
    classification: "Adaptar",
    rationale:
      "La continuidad de todos y compactación (sección de keyword detector y continuidad del plan) se adapta: V2 no expone `session.todo` ni `todowrite`, por lo que la tarea 22 define un registro propio ligado al sessionID.",
    futureEvidence: "task:22",
  },
}
