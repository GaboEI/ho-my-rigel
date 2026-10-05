/**
 * Clasificación de migración para las superficies V1 de MCP de OmO.
 *
 * Cada fila mapea un módulo real bajo
 * `packages/omo-opencode/src/mcp/<fila>.ts` (o su directorio `shared/`) a su
 * destino en el runtime nativo de OpenCode V2. El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `mcp` del ledger.
 *
 * El sistema MCP de tres capas se migra completo: los builtins tier-1
 * (`websearch`, `context7`, `grep_app`, `lsp`) y los helpers de runtime que
 * resuelven el CLI del MCP local `lsp` (`cli-suffix`, `runtime-executable`,
 * `shared`). La política de propiedad vive en
 * `profiles/gabo/integration-manifest.json` (`mcpPolicy`).
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "cli-suffix": {
    classification: "Migrar",
    rationale:
      "El helper `hasCliSuffix` de `packages/omo-opencode/src/mcp/cli-suffix.ts` es soporte de runtime del MCP local tier-1 `lsp`, porque normaliza separadores y decide entre CLI dist y fuente. Se migra con la resolución del CLI, conservando la política `mcpPolicy.omoBuiltinsRetained` de `profiles/gabo/integration-manifest.json` que mantiene `lsp` disponible.",
    futureEvidence: "task:task:38",
  },
  context7: {
    classification: "Migrar",
    rationale:
      "El MCP remoto tier-1 `context7` de `packages/omo-opencode/src/mcp/context7.ts` se migra como conexión externa singleton, aunque el perfil lo desactive. La política `mcpPolicy.context7` y `mcpPolicy.omoBuiltinsDisabled` de `profiles/gabo/integration-manifest.json` exige un único Context7 de OmO y su desactivación en el builtin, sin perder la capacidad.",
    futureEvidence: "gate:disabled_mcps",
  },
  "grep-app": {
    classification: "Migrar",
    rationale:
      "El MCP remoto tier-1 `grep_app` de `packages/omo-opencode/src/mcp/grep-app.ts` se migra como búsqueda de código en GitHub sin autenticación. La política `mcpPolicy.omoBuiltinsRetained` de `profiles/gabo/integration-manifest.json` lo mantiene disponible en el runtime nativo V2.",
    futureEvidence: "task:task:38",
  },
  lsp: {
    classification: "Migrar",
    rationale:
      "El MCP local stdio tier-1 `lsp` de `packages/omo-opencode/src/mcp/lsp.ts` se migra con su resolución de CLI dist o fuente y su daemon compartido. La política `mcpPolicy.omoBuiltinsRetained` de `profiles/gabo/integration-manifest.json` lo conserva como builtin retenido.",
    futureEvidence: "task:task:38",
  },
  "runtime-executable": {
    classification: "Migrar",
    rationale:
      "El resolvedor `resolveRuntimeExecutable` de `packages/omo-opencode/src/mcp/runtime-executable.ts` es soporte de runtime del MCP local tier-1 `lsp`, porque localiza node o bun de forma segura. Se migra con la resolución del CLI, respetando `mcpPolicy.omoBuiltinsRetained` de `profiles/gabo/integration-manifest.json`.",
    futureEvidence: "task:task:38",
  },
  shared: {
    classification: "Migrar",
    rationale:
      "El resolvedor `createAncestorCliCandidates` de `packages/omo-opencode/src/mcp/shared/ancestor-cli-resolver.ts` es soporte de runtime del MCP local tier-1 `lsp`, porque busca el CLI en directorios ancestros. Se migra con la resolución del CLI, respetando `mcpPolicy.omoBuiltinsRetained` de `profiles/gabo/integration-manifest.json`.",
    futureEvidence: "task:task:38",
  },
  websearch: {
    classification: "Migrar",
    rationale:
      "El MCP remoto tier-1 `websearch` de `packages/omo-opencode/src/mcp/websearch.ts` se migra con proveedor Exa o Tavily y clave opcional. La política `mcpPolicy.websearch` de `profiles/gabo/integration-manifest.json` fija Tavily como proveedor del perfil.",
    futureEvidence: "gate:websearch.provider",
  },
}
