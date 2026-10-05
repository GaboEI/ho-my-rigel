/**
 * Clasificación de migración para las superficies `cli/` de OmO V1.
 *
 * Cada fila mapea un directorio o archivo real bajo
 * `packages/omo-opencode/src/cli/` a su destino en el runtime nativo de
 * OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs` y sus satélites).
 * La política de alcance la fija el plan `migracion-espejo-v2-omr.md`: el CLI
 * se reduce al subconjunto necesario (doctor, install, version) y el resto se
 * documenta como adaptado o cubierto por el CLI propio de OpenCode, sin
 * descartar ninguna superficie en silencio. El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `cli` del ledger.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  boulder: {
    classification: "Adaptar",
    rationale:
      "El inspector de estado boulder de `packages/omo-opencode/src/cli/boulder/boulder.ts` se adapta al registro de continuidad nativo de V2, ya que el CLI de OpenCode no ofrece un comando de progreso boulder.",
    futureEvidence: "task:22",
  },
  cleanup: {
    classification: "Adaptar",
    rationale:
      "La limpieza de estado Codex Light de `packages/omo-opencode/src/cli/cleanup.ts` se adapta o se reduce, porque el CLI de OpenCode no desinstala artefactos gestionados por el plugin.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "cleanup-command": {
    classification: "Adaptar",
    rationale:
      "El cableado del comando cleanup/uninstall de `packages/omo-opencode/src/cli/cleanup-command.ts` se adapta dentro del subconjunto reducido del CLI, documentando que OpenCode no tiene un comando equivalente.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "cli-installer": {
    classification: "Adaptar",
    rationale:
      "El instalador no interactivo de `packages/omo-opencode/src/cli/cli-installer.ts` se adapta al instalador del runtime nativo, conservando la selección de proveedores y la generación de configuración.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs",
  },
  "cli-program": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "El programa Commander de `packages/omo-opencode/src/cli/cli-program.ts` es el cableado de entrada del CLI y no aporta comportamiento de runtime propio al espejo V2.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "codex-ulw-loop": {
    classification: "Adaptar",
    rationale:
      "El comando ulw-loop de Codex Light en `packages/omo-opencode/src/cli/codex-ulw-loop.ts` se adapta o se reduce, porque pertenece a la edición Codex y no al runtime nativo de OpenCode V2.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "config-manager": {
    classification: "Adaptar",
    rationale:
      "Las utilidades de configuración de `packages/omo-opencode/src/cli/config-manager/` (registro de plugin, JSONC, versiones) se adaptan al esquema unificado de V2, que resuelve la configuración de otra forma.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "config-migrate": {
    classification: "Adaptar",
    rationale:
      "La migración de configuración legada de `packages/omo-opencode/src/cli/config-migrate.ts` se adapta al motor de migración de la configuración unificada de V2, sin comando equivalente en OpenCode.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  doctor: {
    classification: "Migrar",
    rationale:
      "El diagnóstico de cuatro categorías de `packages/omo-opencode/src/cli/doctor/` se mantiene como subconjunto necesario del CLI, portando sus comprobaciones al runtime nativo de V2.",
    futureEvidence: "task:25",
  },
  "fallback-chain-resolution": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "La resolución de cadenas de fallback de `packages/omo-opencode/src/cli/fallback-chain-resolution.ts` es lógica de generación de configuración en instalación, sin superficie de runtime propia; el fallback de runtime lo cubre la tarea 8.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "fallback-lane-policy": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "La política de carriles excluidos de `packages/omo-opencode/src/cli/fallback-lane-policy.ts` solo participa en la generación de configuración de instalación y no expone comportamiento de runtime en V2.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "get-local-version": {
    classification: "Migrar",
    rationale:
      "La detección de versión instalada frente a la publicada de `packages/omo-opencode/src/cli/get-local-version/get-local-version.ts` se mantiene como subconjunto necesario del CLI nativo.",
    futureEvidence: "task:25",
  },
  install: {
    classification: "Migrar",
    rationale:
      "El instalador de `packages/omo-opencode/src/cli/install.ts` se mantiene como subconjunto necesario del CLI, portando la selección de proveedores y el registro del plugin al runtime nativo de V2.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs",
  },
  "install-ast-grep-sg": {
    classification: "Adaptar",
    rationale:
      "El aprovisionamiento del binario sg de `packages/omo-opencode/src/cli/install-ast-grep-sg.ts` se adapta al instalador nativo, porque en V2 ast-grep se sirve como skill y no requiere este paso separado.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "install-codex": {
    classification: "Adaptar",
    rationale:
      "La instalación de la edición Codex Light de `packages/omo-opencode/src/cli/install-codex/` se adapta o se reduce, porque pertenece al harness Codex y queda fuera del espejo nativo de OpenCode V2.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "install-native": {
    classification: "Adaptar",
    rationale:
      "El instalador de OmO Native de `packages/omo-opencode/src/cli/install-native/` se adapta o se reduce, porque instala otro runtime distinto del espejo nativo de OpenCode V2.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "install-native-dev": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "El envoltorio de instalación nativa de desarrollo de `packages/omo-opencode/src/cli/install-native-dev/index.ts` solo reenvía al instalador de senpi y no aporta comportamiento de runtime propio.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "install-validators": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "Las validaciones de plataforma y opciones de `packages/omo-opencode/src/cli/install-validators.ts` son comprobaciones de build del instalador, sin superficie de runtime propia en V2.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "mcp-oauth": {
    classification: "Adaptar",
    status: "Migrado parcialmente",
    rationale:
      "El flujo OAuth PKCE de MCP de tier 3 vive en el manager nativo (`rigel-v2-skill-mcp-oauth.mjs`); el comando interactivo de CLI `mcp oauth login` no tiene puerto porque el runtime nativo no ejecuta el CLI de OmO. Parcial aceptado por decision de mantenedor 2026-10-05 para el cierre de Fase 4; destino: clasificacion en Fase 5.",
    futureEvidence: "`rigel-v2-skill-mcp-oauth.mjs`; `rigel-v2-skill-mcp-oauth.test.mjs`",
  },
  "minimum-opencode-version": {
    classification: "Adaptar",
    rationale:
      "La verificación de versión mínima de `packages/omo-opencode/src/cli/minimum-opencode-version.ts` se adapta al binario V2 y a su versión mínima verificada.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "model-fallback": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La generación de configuración de fallback por disponibilidad de proveedores de `packages/omo-opencode/src/cli/model-fallback.ts` se adapta al esquema unificado de V2; el fallback de runtime se porta en la tarea 8.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "model-fallback-requirements": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "Las cadenas de fallback por agente de `packages/omo-opencode/src/cli/model-fallback-requirements.ts` se adaptan al runtime nativo, con las cadenas portadas desde model-core en la tarea 8.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "model-fallback-types": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "Los tipos de `packages/omo-opencode/src/cli/model-fallback-types.ts` son contratos de datos de la generación de configuración de instalación y no tienen superficie de runtime propia.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "native-dev-platform-flag": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "La bandera de plataforma nativa de desarrollo de `packages/omo-opencode/src/cli/native-dev-platform-flag.ts` solo decide opciones del instalador y no expone comportamiento de runtime.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "native-edition-hint": {
    classification: "Adaptar",
    rationale:
      "El aviso de la edición OmO Native de `packages/omo-opencode/src/cli/native-edition-hint.ts` se adapta al instalador nativo, porque promociona un runtime distinto del espejo V2.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "openai-only-model-catalog": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El filtrado de catálogo solo OpenAI de `packages/omo-opencode/src/cli/openai-only-model-catalog.ts` se adapta a la resolución de modelos del runtime nativo de V2.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs; rigel-v2-native-model-chains.test.mjs",
  },
  "provider-availability": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La detección de disponibilidad de proveedores de `packages/omo-opencode/src/cli/provider-availability.ts` se adapta a las credenciales y proveedores reales del runtime nativo de V2.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (readAvailableModels)",
  },
  "provider-model-id-transform": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "El reenvío de transformación de id de modelo de `packages/omo-opencode/src/cli/provider-model-id-transform.ts` es un shim de model-core sin comportamiento de runtime propio.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (modelKey/parseModel)",
  },
  "refresh-model-capabilities": {
    classification: "Adaptar",
    rationale:
      "El refresco de la caché de capacidades de modelos de `packages/omo-opencode/src/cli/refresh-model-capabilities.ts` se adapta al runtime nativo, que resuelve las capacidades por otra vía.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  run: {
    classification: "Equivale a builtin V2",
    rationale:
      "El lanzador de sesión no interactiva de `packages/omo-opencode/src/cli/run/runner.ts` queda cubierto por el comando nativo `opencode run`; la continuidad V1 se rastrea en el modo continuations de la tarea 22.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "runtime-commands": {
    classification: "Adaptar",
    rationale:
      "El registro de comandos de runtime de `packages/omo-opencode/src/cli/runtime-commands.ts` se adapta al subconjunto reducido del CLI nativo, conservando solo los comandos con equivalente.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "star-request": {
    classification: "Adaptar",
    rationale:
      "La solicitud de estrella en GitHub de `packages/omo-opencode/src/cli/star-request.ts` se adapta o se reduce, porque es una cortesía del instalador sin equivalente en el CLI de OpenCode.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
  "tui-install-prompts": {
    classification: "Adaptar",
    rationale:
      "Los prompts interactivos de `packages/omo-opencode/src/cli/tui-install-prompts.ts` se adaptan al instalador nativo, conservando las mismas decisiones de proveedor y plataforma.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs",
  },
  "tui-installer": {
    classification: "Adaptar",
    rationale:
      "El instalador interactivo de `packages/omo-opencode/src/cli/tui-installer.ts` se adapta al flujo nativo del runtime V2, sin dependencia del plugin V1.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs",
  },
  "worktree-sweep": {
    classification: "Adaptar",
    rationale:
      "El barrido de worktrees obsoletos de `packages/omo-opencode/src/cli/worktree-sweep/worktree-sweep.ts` se adapta al flujo de PR del espejo, ya que el CLI de OpenCode no barre worktrees.",
    futureEvidence: "contract:qa-v2-cli-reduction.mjs",
  },
}
