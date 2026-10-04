/**
 * Clasificación de migración para las superficies V1 de OmO bajo
 * `packages/omo-opencode/src/plugin/`.
 *
 * Cada fila mapea un módulo real de `plugin/` a su destino en el runtime
 * nativo de OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs`,
 * `rigel-v2-native-core.mjs`, `rigel-v2-native-prompt.mjs`). El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `plugin` del ledger.
 *
 * Frontera V2: `OH-MY-RIGEL.md` (líneas 56-80) y `AGENTS.rigel.md` declaran
 * que V2 no tiene mapeo verificado para `chat.headers`, `chat.params`,
 * `command.execute.before`, `config`, `event`,
 * `experimental.chat.messages.transform`,
 * `experimental.compaction.autocontinue` y `tool.definition`; esos handlers
 * se reportan en el arranque en vez de declararse activos.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "available-categories": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/available-categories.ts` solo construye la lista `AvailableCategory[]` que alimenta el prompt de agentes; no expone comportamiento propio y viaja con la capacidad de categorías que lo consume.",
    futureEvidence: "task:17",
  },
  "build-team-idle-wake-hint-client": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/build-team-idle-wake-hint-client.ts` solo acota el cliente SDK a `promptAsync`/`status`/`messages` para el handler de team mode; es soporte de construcción sin comportamiento de runtime propio.",
    futureEvidence: "task:16",
  },
  "chat-headers": {
    classification: "Adaptar",
    rationale:
      "`plugin/chat-headers.ts` inyecta la cabecera `x-initiator` de Copilot, pero V2 no tiene mapeo verificado para `chat.headers`; se adapta en la frontera `http.request` que el runtime nativo ya usa en `rigel-v2-native.mjs`.",
    futureEvidence: "task:23",
  },
  "chat-message": {
    classification: "Adaptar",
    rationale:
      "`plugin/chat-message.ts` resuelve la variante del primer mensaje, la sesión y la detección de keywords; V2 no expone `chat.message`, así que se adapta en la frontera `http.request` de `rigel-v2-native-prompt.mjs`.",
    futureEvidence: "task:20",
  },
  "chat-params": {
    classification: "Adaptar",
    rationale:
      "`plugin/chat-params.ts` ajusta esfuerzo Anthropic, think mode y fallback de modelo, pero V2 no tiene mapeo verificado para `chat.params`; se adapta mutando el cuerpo real de la petición en la frontera `http.request`.",
    futureEvidence: "task:23",
  },
  "command-execute-before": {
    classification: "Adaptar",
    rationale:
      "`plugin/command-execute-before.ts` aplica guards de comando (stop-continuation, /goal, ulw-execute), pero V2 no tiene mapeo verificado para `command.execute.before`; se adapta al modelo de comandos nativo de V2.",
    futureEvidence: "task:20",
  },
  event: {
    classification: "Adaptar",
    rationale:
      "`plugin/event.ts` cablea el ciclo de vida de sesión, openclaw y fallback reactivo, pero V2 no tiene mapeo verificado para `event`; se adapta a la suscripción de eventos nativa que `rigel-v2-native.mjs` ya usa para el handoff de background.",
    futureEvidence: "task:20",
  },
  "event-error-utils": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/event-error-utils.ts` solo normaliza nombres y mensajes de error para el handler de eventos; es soporte de construcción sin superficie de runtime propia.",
    futureEvidence: "task:20",
  },
  "event-hook-dispatcher": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/event-hook-dispatcher.ts` solo resuelve el sessionID y ejecuta los hooks de evento con aislamiento de errores; es plomería de despacho, no un handler de comportamiento.",
    futureEvidence: "task:20",
  },
  "event-model-fallback": {
    classification: "Adaptar",
    rationale:
      "`plugin/event-model-fallback.ts` implementa el fallback reactivo sobre errores de sesión; se adapta a la suscripción de eventos nativa de V2 y a las cadenas de `model-core`, como exige la tarea de fallback.",
    futureEvidence: "task:8",
  },
  "event-model-fallback-state": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/event-model-fallback-state.ts` solo mantiene el estado de continuación y deduplicación del fallback reactivo; es soporte de construcción que viaja con el handler de fallback.",
    futureEvidence: "task:8",
  },
  "event-session-lifecycle": {
    classification: "Adaptar",
    rationale:
      "`plugin/event-session-lifecycle.ts` maneja created/deleted/idle/error y el estado de sesión; se adapta a los eventos nativos de V2 que el runtime nativo ya consume para el handoff de background.",
    futureEvidence: "task:20",
  },
  "event-team-handlers": {
    classification: "Adaptar",
    rationale:
      "`plugin/event-team-handlers.ts` cablea los cuatro handlers de team mode (orphan, member error, member status, idle wake hint); se adapta a los eventos nativos de V2 porque team mode se migra completo.",
    futureEvidence: "task:16",
  },
  "event-types": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/event-types.ts` solo declara los tipos de entrada y salida del handler de eventos; es una superficie de tipos sin comportamiento de runtime.",
    futureEvidence: "task:20",
  },
  hooks: {
    classification: "Migrar",
    rationale:
      "`plugin/hooks/` compone los tiers Session, ToolGuard, Transform, Continuation y Skill que el runtime nativo V2 debe reproducir; se migra completo con equivalencia demostrada por el oráculo diferencial.",
    futureEvidence: "task:18",
  },
  "messages-transform": {
    classification: "Adaptar",
    status: "Migrado parcialmente",
    rationale:
      "`plugin/messages-transform.ts` cablea los inyectores sobre `experimental.chat.messages.transform` y ademas valida bloques de pensamiento, pares de herramientas y repara la cola assistant-prefill; es una superficie mas amplia que T19. T19 reubico la inyeccion de directorio y reglas al resultado de lectura (`tool.execute.after`) y el roster, ultrawork, la guia raiz de Hephaestus y el recordatorio de categoria en `http.request`; la validacion de pensamiento/pares y la reparacion de prefill no se reimplementaron y siguen pendientes.",
    futureEvidence: "`rigel-v2-native-prompt.mjs`; `rigel-v2-directory-instructions.mjs`; `rigel-v2-native-rules.mjs`",
  },
  "native-skills": {
    classification: "Migrar",
    rationale:
      "`plugin/native-skills.ts` carga las skills nativas del host V2 y alimenta el descubrimiento perezoso de skill/delegate; se porta a la superficie nativa de skills del runtime V2.",
    futureEvidence: "task:14",
  },
  "normalize-tool-arg-schemas": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/normalize-tool-arg-schemas.ts` solo coacciona los esquemas de argumentos de herramientas a una forma normalizada; es plomería de registro sin comportamiento de runtime propio.",
    futureEvidence: "task:14",
  },
  "recent-synthetic-idles": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/recent-synthetic-idles.ts` solo deduplica eventos idle sintéticos recientes para el handler de eventos; es soporte de construcción sin superficie de runtime propia.",
    futureEvidence: "task:20",
  },
  "runtime-skill-resolver": {
    classification: "Migrar",
    rationale:
      "`plugin/runtime-skill-resolver.ts` lee las skills del config fusionado en runtime para descubrir fuentes que otros plugins agregan; se porta a la superficie nativa de skills de V2.",
    futureEvidence: "task:14",
  },
  "session-agent-resolver": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/session-agent-resolver.ts` solo resuelve qué agente posee una sesión leyendo sus mensajes; es un helper de construcción que consumen los guards de herramientas.",
    futureEvidence: "task:20",
  },
  "session-compacting": {
    classification: "Adaptar",
    rationale:
      "`plugin/session-compacting.ts` preserva contexto y todos en la compactación, pero V2 no tiene mapeo verificado para `experimental.session.compacting`; se adapta en la frontera `http.request` del resumen.",
    futureEvidence: "task:21",
  },
  "session-status-normalizer": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/session-status-normalizer.ts` solo normaliza `session.status` idle a `session.idle` entre versiones de OpenCode; es plomería de normalización sin comportamiento propio.",
    futureEvidence: "task:20",
  },
  "skill-context": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/skill-context.ts` solo descubre y fusiona skills para construir el contexto compartido con la creación de herramientas; es soporte de construcción sin superficie de runtime.",
    futureEvidence: "task:14",
  },
  "stop-continuation": {
    classification: "Migrar",
    rationale:
      "`plugin/stop-continuation.ts` detiene keyword detector, guard de continuación, enforcer de todos y goal para una sesión; se porta a la superficie nativa V2 como parte del flujo de continuidad.",
    futureEvidence: "task:20",
  },
  "system-transform": {
    classification: "Adaptar",
    rationale:
      "`plugin/system-transform.ts` reconcilia el prompt de Sisyphus y restaura ultrawork a nivel de sistema; se adapta a la inyección de contexto en la frontera `http.request` de `rigel-v2-native-prompt.mjs`.",
    futureEvidence: "task:20",
  },
  "tool-definition": {
    classification: "Adaptar",
    rationale:
      "`plugin/tool-definition.ts` aplica el override de descripción de todos, pero V2 no tiene mapeo verificado para `tool.definition`; se adapta al registro de herramientas nativo de V2.",
    futureEvidence: "task:20",
  },
  "tool-execute-after": {
    classification: "Migrar",
    rationale:
      "`plugin/tool-execute-after.ts` runs truncation, comment-checker, hashline read tagging and error recovery; the native `execute.after` hook registered by `rigel-v2-native.mjs` now invokes recovery (edit + JSON), the comment-checker (real binary) and the plan-format validator, on top of the reminders and rules already migrated.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "tool-execute-before": {
    classification: "Migrar",
    rationale:
      "`plugin/tool-execute-before.ts` aplica guards previos (mcp_ strip, bloqueo de sleep, resolución de subagente, dispatch de skill); se migra al hook `execute.before` nativo que `rigel-v2-native.mjs` ya registra.",
    futureEvidence: "task:18",
  },
  "tool-registry": {
    classification: "Migrar",
    rationale:
      "`plugin/tool-registry.ts` ensambla el registro de herramientas con sus gates de configuración; se migra al registro nativo de V2 respetando cada gate en runtime.",
    futureEvidence: "task:14",
  },
  "tool-registry-core-tools": {
    classification: "Migrar",
    rationale:
      "`plugin/tool-registry-core-tools.ts` construye las herramientas base (grep, glob, sesión, background, task, skill); se migra al registro nativo de V2 con la semántica V1.",
    futureEvidence: "task:14",
  },
  "tool-registry-factories": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/tool-registry-factories.ts` solo agrupa las fábricas de herramientas en un objeto inyectable; es plomería de construcción sin comportamiento de runtime propio.",
    futureEvidence: "task:14",
  },
  "tool-registry-gated-tools": {
    classification: "Migrar",
    rationale:
      "`plugin/tool-registry-gated-tools.ts` arma las familias condicionales (task system, hashline, monitor, goal); se migra al registro nativo de V2 respetando cada gate de configuración.",
    futureEvidence: "task:16",
  },
  "tool-registry-team-tools": {
    classification: "Migrar",
    rationale:
      "`plugin/tool-registry-team-tools.ts` arma las doce herramientas de team mode y el override de modelo de Sisyphus-Junior; se migra al registro nativo de V2 porque team mode se migra completo.",
    futureEvidence: "task:16",
  },
  "tool-registry-trimming": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/tool-registry-trimming.ts` solo recorta el registro cuando se fija `experimental.max_tools`; es plomería de construcción sin comportamiento de runtime propio.",
    futureEvidence: "task:14",
  },
  "ultrawork-db-model-override": {
    classification: "Adaptar",
    rationale:
      "`plugin/ultrawork-db-model-override.ts` programa un override de modelo a nivel de base de datos para ultrawork; se adapta a la mutación del cuerpo real de la petición en la frontera `http.request` de V2.",
    futureEvidence: "task:23",
  },
  "ultrawork-model-override": {
    classification: "Adaptar",
    rationale:
      "`plugin/ultrawork-model-override.ts` detecta ultrawork y aplica el override de modelo y variante por mensaje; se adapta a la frontera `http.request` porque V2 fija la variante antes de esa frontera.",
    futureEvidence: "task:23",
  },
  "ultrawork-variant-availability": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "`plugin/ultrawork-variant-availability.ts` solo consulta los proveedores para validar que una variante de ultrawork existe; es soporte de construcción del override de modelo.",
    futureEvidence: "task:23",
  },
  "unstable-agent-babysitter": {
    classification: "Migrar",
    rationale:
      "`plugin/unstable-agent-babysitter.ts` rastrea agentes inestables entre sesiones y alimenta el hook de babysitter; se porta a la superficie nativa V2 junto con el manager de background.",
    futureEvidence: "task:20",
  },
}
