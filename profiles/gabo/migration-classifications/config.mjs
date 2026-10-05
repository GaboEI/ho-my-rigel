/**
 * Clasificación de migración para las superficies V1 de configuración de OmO.
 *
 * Cada fila mapea un módulo real bajo
 * `packages/omo-opencode/src/config/<fila>.ts` (o el directorio `schema/`) a su
 * destino en el runtime nativo de OpenCode V2. El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `config` del ledger.
 *
 * El runtime nativo V2 lee `omo.jsonc`; el esquema Zod es el contrato de
 * claves y defaults, y el cargador (`validate` + `prune-plugin-view`) es la
 * superficie de runtime que lo valida, fusiona y degrada. La política de
 * alcance vive en `profiles/gabo/integration-manifest.json` (`nonGoals`).
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "prune-plugin-view": {
    classification: "Migrar",
    rationale:
      "`prunePluginView` de `packages/omo-opencode/src/config/prune-plugin-view.ts` descarta en runtime los valores inválidos de una vista con una advertencia por clave, apoyándose en `@oh-my-opencode/omo-config-core`. Se migra al cargador nativo V2 para conservar la degradación parcial, respetando el nonGoal de `profiles/gabo/integration-manifest.json` de no instalar en la configuración activa de OpenCode.",
    futureEvidence: "task:task:38",
  },
  schema: {
    classification: "Migrar",
    rationale:
      "El esquema Zod de `packages/omo-opencode/src/config/schema/` es el contrato de claves y defaults que el runtime nativo V2 debe leer desde `omo.jsonc`. Se migra como contrato de configuración, respetando el nonGoal de `profiles/gabo/integration-manifest.json` de no instalar en la configuración activa de OpenCode.",
    futureEvidence: "task:task:38",
  },
  validate: {
    classification: "Migrar",
    rationale:
      "`validatePluginConfig` de `packages/omo-opencode/src/config/validate.ts` carga la cadena `omo.jsonc`, fusiona vistas, protege campos de usuario y migra claves legadas en runtime. Se migra al cargador nativo V2, respetando el nonGoal de `profiles/gabo/integration-manifest.json` de no instalar en la configuración activa de OpenCode.",
    futureEvidence: "task:task:38",
  },
}
