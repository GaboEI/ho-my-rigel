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
    status: "Migrado",
    rationale:
      "La expansion de Hyperplan del keyword detector se adapta a la superficie nativa de keywords de V2: `rigel-v2-keyword-core.mjs` reconoce `hyperplan` y el combo `hyperplan`+`ultrawork` con la negacion `interface.hpp`, y `rigel-v2-native-keyword-seam.mjs` inyecta el cuerpo V1 staged en la frontera `http.request`; la supresion del cuerpo standalone cuando dispara el combo se prueba en el drive staged (14/14).",
    futureEvidence:
      "`rigel-v2-keyword-core.mjs`; `rigel-v2-native-keyword-seam.mjs`; `.omo/evidence/20261005-task-20/t12-keyword-seam.md`",
  },
  "Team mode": {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "El team mode (gate `team_mode.enabled`) corre en V2 con las 12 herramientas team_*, los 4 handlers de eventos, el gating por rol y los inyectores de mailbox/estado sobre el storage nativo. Gap exacto: worktrees por miembro (la visualizacion tmux ya esta reescrita). Parcial aceptado por decision de mantenedor 2026-10-05 para el cierre de Fase 4; destino: clasificacion en Fase 5.",
    futureEvidence: "`tools/team.tools.mjs`; `rigel-v2-team-events.mjs`; `rigel-v2-team-gating.mjs`; `rigel-v2-native.mjs` (wiring gate team_mode)",
  },
  Goal: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El modo Goal (sección de goal del plan, gate `goal.enabled`) se migra con `create_goal`, `update_goal` y `get_goal` portados a la superficie nativa de V2 como indica la tarea 16.",
    futureEvidence: "tools/goal.tools.mjs; rigel-v2-native.mjs (comando goal); rigel-v2-native-conditional-tools.test.mjs",
  },
  continuations: {
    classification: "Adaptar",
    rationale:
      "La continuidad de todos y compactación (sección de keyword detector y continuidad del plan) se adapta: V2 no expone `session.todo` ni `todowrite`, por lo que la tarea 22 define un registro propio ligado al sessionID.",
    futureEvidence: "task:22",
  },
}
