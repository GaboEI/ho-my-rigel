/**
 * Clasificación de migración para los módulos de features V1 de OmO.
 *
 * Cada fila mapea un directorio real bajo
 * `packages/omo-opencode/src/features/<fila>/` a su destino en el runtime
 * nativo de OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs`,
 * `rigel-v2-native-core.mjs` y `rigel-v2-native-prompt.mjs`). Varios módulos
 * son shims del adaptador sobre paquetes de núcleo extraídos
 * (`packages/team-core/`, `packages/tmux-core/`, `packages/skills-loader-core/`,
 * `packages/mcp-client-core/`, `packages/claude-code-compat-core/`,
 * `packages/boulder-state/`). El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `features` del ledger.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "background-agent": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El motor de ciclo de vida de tareas de `features/background-agent/` se porta al runtime nativo V2 sobre eventos de sesion y un registro propio. `rigel-v2-background-manager.mjs` compone la cola FIFO por clave y el reintento (`rigel-v2-background-queue.mjs`, `rigel-v2-background-retry.mjs`), el handoff no bloqueante (`rigel-v2-background-handoff.mjs`, tope MAX_WAKE_ATTEMPTS=3) y el marcador de continuacion en disco (`rigel-v2-background-marker.mjs`, `.omo/run-continuation/<parent>.json`, fuente `background-task`) sin ningun timer ni poller. `rigel-v2-native.mjs` encola el handoff (sin await) en el bucle de eventos y limpia los hijos en `session.deleted` mediante el registro de T11.",
    futureEvidence:
      "`rigel-v2-background-manager.mjs`; `rigel-v2-background-queue.mjs`; `rigel-v2-background-retry.mjs`; `rigel-v2-background-handoff.mjs`; `rigel-v2-background-marker.mjs`; `rigel-v2-background-manager.test.mjs`; `rigel-v2-background-queue.test.mjs`; `rigel-v2-background-retry.test.mjs`",
  },
  "boulder-state": {
    classification: "Migrar",
    rationale:
      "El estado persistente de trabajo boulder de `features/boulder-state/` sobre `packages/boulder-state/` sostiene el plan activo entre sesiones y se migra como base del enforcer de continuidad nativo de V2.",
    futureEvidence: "task:22",
  },
  "btw-side": {
    classification: "Adaptar",
    rationale:
      "Las conversaciones laterales efímeras de `features/btw-side/` inyectan contexto del padre mediante un hook Transform que V2 no ofrece; se adapta el inyector a la frontera `http.request` reescribiendo el payload real de la petición.",
    futureEvidence: "contract:qa-v2-native-prompt-contract.mjs",
  },
  "builtin-commands": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Las plantillas de comandos de `features/builtin-commands/` (refactor, ulw-execute, stop-continuation, handoff, remove-ai-slops, hyperplan, goal) se migran al modelo de comandos de V2 conservando los mismos disparadores y cuerpos. `goal` y `ulw-execute` se registran directamente en el runtime nativo; `stop-continuation` se entrega por el seam de prompt; los cuatro comandos restantes (`refactor`, `remove-ai-slops`, `handoff`, `hyperplan`) se registran via `ctx.command.transform` con su plantilla V1 generada desde el dueno y entregada al turno real de la sesion (`ctx.session.prompt`).",
    futureEvidence: "`rigel-v2-native-builtin-commands.mjs`; `rigel-v2-native-builtin-command-manifest.mjs`; `generate-v2-builtin-command-manifest.mjs`; `rigel-v2-native-builtin-commands.test.mjs`; `generate-v2-builtin-command-manifest.test.mjs`; `rigel-v2-native-runtime.test.mjs`; `qa-v2-builtin-commands-contract.mjs`; `.omo/evidence/20261006-t35-builtin-commands/task-35.txt`",
  },
  "claude-code-agent-loader": {
    classification: "Migrar",
    rationale:
      "La carga de agentes desde `.opencode/agents/` y plugins de Claude Code de `features/claude-code-agent-loader/` delega en `packages/claude-code-compat-core/`; se migra reutilizando el cargador neutral y registrando el resultado en el roster de V2.",
    futureEvidence: "contract:qa-v2-agent-domain.mjs",
  },
  "claude-code-command-loader": {
    classification: "Migrar",
    rationale:
      "La carga de comandos desde `.opencode/commands/` y plugins de Claude Code de `features/claude-code-command-loader/` sobre `packages/claude-code-compat-core/` se migra al modelo de comandos de V2 junto con builtin-commands.",
    futureEvidence: "task:task:35",
  },
  "claude-code-mcp-loader": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El cargador MCP de tier 2 de `features/claude-code-mcp-loader/` esta portado: la lista de archivos V1 (.claude.json, .mcp.json user y project, .claude/.mcp.json local), last-wins, `disabled: true` que elimina de scopes previos, filtro de scope local, expansion `${VAR}`/`${VAR:-default}` con la regla de seguridad V1 (la allowlist `mcp_env_allowlist` es de capa usuario y un proyecto no puede extenderla) y registro via `ctx.mcp.transform` con la traduccion local/remote del loader tier-3.",
    futureEvidence: "`rigel-v2-claude-code-mcp.mjs`; `rigel-v2-claude-code-mcp.test.mjs`; `rigel-v2-native-config.mjs` (readNativeMcpPolicy, allowlist solo capa user); `rigel-v2-native.mjs` (registro); mutaciones del ledger (2 casos tier-2)",
  },
  "claude-code-session-state": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "El registro en memoria de sesiones de subagente de `features/claude-code-session-state/` no expone comportamiento propio; es un módulo de soporte que viaja con la superficie de delegación e inyección que lo consume.",
    futureEvidence: "contract:qa-v2-native-delegation.mjs",
  },
  "claude-tasks": {
    classification: "Adaptar",
    rationale:
      "El esquema y almacenamiento atómico de tareas de `features/claude-tasks/` se migran, pero su sincronización con la API de todos de OpenCode es un muro de V2 y se adapta con el registro persistente propio de la tarea 22.",
    futureEvidence: "task:22",
  },
  "context-injector": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`features/context-injector/` es un colector generico de contexto (register/getPending/consume con orden por prioridad y separador canonico) mas un hook de transform. Ola 4b lo porto completo: el colector nativo (`rigel-v2-context-collector.mjs`) alimenta el consumidor del hook `context` de V2 (`event.messages`), y el productor claude-code-hooks registra su contexto con source custom y prioridad high. El consumo real en la peticion del proveedor se demostro en el lab con un proveedor simulado loopback (captura del body con el marcador del hook).",
    futureEvidence: "`rigel-v2-context-collector.mjs`; `rigel-v2-native-prompt.test.mjs` (casos del colector); `rigel-v2-claude-code-hooks.mjs`; `rigel-v2-native.mjs` (hook context); `live-qa/wave4-collector-claude-code-hooks.md`; `live-qa/wave4b-mock-provider-capture.json`",
  },
  "hook-message-injector": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "El inyector de mensajes de sistema de `features/hook-message-injector/` es un helper de soporte consumido por otros hooks y no expone comportamiento propio; viaja con los hooks que lo usan.",
    futureEvidence: "task:task:29",
  },
  "mcp-oauth": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El flujo OAuth 2.0 con PKCE, DCR y step-up de `features/mcp-oauth/` sobre `packages/mcp-client-core/` se migra como parte del sistema MCP de tres niveles de V2 con la misma seguridad.",
    futureEvidence: "`rigel-v2-skill-mcp-oauth.mjs`; `rigel-v2-native-skill-mcp.mjs`; `rigel-v2-skill-mcp-oauth.test.mjs`",
  },
  monitor: {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "El backend de `monitor_start/stop/list/output` de `features/monitor/` (procesos vigilados, anillo de salida, filtrado e inyección por lotes) se porta a V2 condicionado a la clave `monitor.enabled`, apagada por defecto.",
    futureEvidence: "gate:monitor.enabled",
  },
  "native-edition-nudge": {
    classification: "Migrar",
    rationale:
      "El aviso de TUI de `features/native-edition-nudge/` que ofrece instalar la edición nativa se migra con su diálogo, acciones y estado de snooze al runtime nativo V2.",
    futureEvidence: "task:task:35",
  },
  "opencode-runtime-skills": {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "La fuente de skills en runtime de `features/opencode-runtime-skills/` se cubre consumiendo el catalogo fusionado del host (`ctx.skill.list()`) con single-flight y fallback al disco (`createRuntimeHostSkillSource`); el servidor de fuente de skills de seguridad por sesion no tiene seam equivalente en el dominio de skills de V2 y se considera adaptado fuera.",
    futureEvidence: "`rigel-v2-native-skills.mjs` (createRuntimeHostSkillSource); `rigel-v2-native-skills.test.mjs`",
  },
  "opencode-skill-loader": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El descubrimiento de skills de cuatro ámbitos con prioridad numérica de `features/opencode-skill-loader/` sobre `packages/skills-loader-core/` se migra para alimentar las herramientas `skill` y `skill_mcp` nativas.",
    futureEvidence: "`rigel-v2-native-skills.mjs` (discoverSkills/registerNativeSkills); `rigel-v2-native-skills.test.mjs`",
  },
  "opengateway-provider": {
    classification: "Migrar",
    rationale:
      "La inyección del proveedor OpenGateway de `features/opengateway-provider/`, activada solo con credencial real y con el catálogo empaquetado, se migra al modelo de configuración de proveedores de V2.",
    futureEvidence: "task:task:24",
  },
  "run-continuation-state": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Los dos orígenes vivos V1, `background-task` y `stop`, se conservan en `.omo/run-continuation/<session>.json`; el manager actualiza el primero y el guard de parada escribe o libera el segundo antes de cancelar descendientes.",
    futureEvidence: "`rigel-v2-background-marker.mjs`; `rigel-v2-background-manager.mjs`; `rigel-v2-background-manager.test.mjs`; `rigel-v2-native-request-steps.test.mjs`",
  },
  "skill-mcp-manager": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El ciclo de vida de MCP de tier 3 de `features/skill-mcp-manager/` sobre `packages/mcp-client-core/`, aislado por la clave `${sessionID}:${skillName}:${serverName}`, se migra para el MCP embebido en skills con transporte stdio y HTTP.",
    futureEvidence: "`rigel-v2-native-skill-mcp.mjs`; `rigel-v2-native.mjs`",
  },
  "task-toast-manager": {
    classification: "Migrar",
    rationale:
      "El gestor de notificaciones de progreso de tareas de `features/task-toast-manager/` se migra a los avisos de la TUI de V2 conservando el seguimiento de estado y la información de fallback de modelo.",
    futureEvidence: "task:task:33",
  },
  "team-mode": {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "La coordinacion multiagente de `features/team-mode/` vive sobre el modelo nativo de storage (`rigel-v2/team/<name>`): las 12 herramientas team_*, los 4 handlers de eventos (idle wake hint, member status, member error, lead orphan), el gating por rol y los inyectores de mailbox y estado. Gap exacto: los worktrees por miembro no tienen puerto. Parcial aceptado por decision de mantenedor 2026-10-05 para el cierre de Fase 4; destino: clasificacion en Fase 5.",
    futureEvidence: "`tools/team.tools.mjs`; `rigel-v2-team-events.mjs`; `rigel-v2-team-gating.mjs`; `rigel-v2-team-events.test.mjs`; `rigel-v2-team-gating.test.mjs`; `rigel-v2-native-conditional-tools.test.mjs`",
  },
  "tmux-subagent": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Resuelto por decision de Gabo (2026-10-05, opcion A): reescritura nativa completa. La visualizacion vive en `profiles/gabo/opencode/rigel-v2-tmux-viz-*.mjs`: elegibilidad y degradacion explicita (`rigel-v2-tmux-viz-env.mjs`), runner del CLI tmux + salud del server (`rigel-v2-tmux-viz-runner.mjs`), query y parseo del estado de paneles con la heuristica de main pane (`rigel-v2-tmux-viz-pane-state.mjs`), planificacion de grid y decisiones de split con las constantes V1 (`rigel-v2-tmux-viz-layout.mjs`), polling con activacion por foco/gracia 5s, estabilidad 10s/3 ticks, grace 30s y timeout 60min (`rigel-v2-tmux-viz-polling.mjs`), cleanup con C-c + kill-pane, reintentos 3/15min y zombie sweep (`rigel-v2-tmux-viz-cleanup.mjs`), y el manager orquestador (`rigel-v2-tmux-viz-manager.mjs`) cableado en `rigel-v2-native.mjs` bajo el gate `team_mode.tmux_visualization`. El contrato completo se demostro contra tmux 3.4 real: deteccion dentro de tmux, split de panel con titulo omo-subagent-*, tracking y limpieza tras session.deleted.",
    futureEvidence: "`rigel-v2-tmux-viz-*.mjs` + `rigel-v2-tmux-viz-*.test.mjs`; `.omo/evidence/20261005-tmux-subagent-native/live-tmux-pane-lifecycle.json`; mutaciones del ledger (5 casos tmux-viz); wiring `rigel-v2-native.mjs`",
  },
  "tool-metadata-store": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "El almacén de metadatos de ejecución de herramientas de `features/tool-metadata-store/` no expone comportamiento propio; es un módulo de soporte que viaja con las herramientas de tarea que publican y recuperan su metadata.",
    futureEvidence: "contract:qa-v2-native-delegation.mjs",
  },
  "tui-sidebar": {
    classification: "Migrar",
    rationale:
      "La barra lateral de TUI de `features/tui-sidebar/`, que deriva roster y estado y publica un espejo para la TUI, se migra bajo la clave de configuración `tui.sidebar.enabled`.",
    futureEvidence: "gate:tui.sidebar.enabled",
  },
}
