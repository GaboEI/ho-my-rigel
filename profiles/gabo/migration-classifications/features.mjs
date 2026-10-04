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
    rationale:
      "El motor de ciclo de vida de tareas de `features/background-agent/` (cola FIFO por clave, sondeo de finalización, circuit breaker y despertar del padre con `parent-wake-notifier.ts`) se porta al runtime nativo V2 sobre eventos de sesión y un registro de tareas propio.",
    futureEvidence: "task:20",
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
    rationale:
      "Las plantillas de comandos de `features/builtin-commands/` (refactor, init-deep, handoff, ulw-loop) se migran al modelo de comandos de V2 conservando los mismos disparadores y cuerpos.",
    futureEvidence: "contract:qa-v2-builtin-commands-contract.mjs",
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
    futureEvidence: "contract:qa-v2-builtin-commands-contract.mjs",
  },
  "claude-code-mcp-loader": {
    classification: "Migrar",
    rationale:
      "El cargador MCP de tier 2 de `features/claude-code-mcp-loader/` (parseo de `.mcp.json` y expansión de `${VAR}` sobre `packages/claude-code-compat-core/`) se migra como segunda capa del sistema MCP de tres niveles de V2.",
    futureEvidence: "task:14",
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
    rationale:
      "La inyección de `AGENTS.md` y `README.md` de `features/context-injector/` apoyada en `packages/agents-md-core/` usa un hook Transform ausente en V2; se adapta a la frontera `http.request` que ya usa `rigel-v2-native-prompt.mjs`.",
    futureEvidence: "task:19",
  },
  "hook-message-injector": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "El inyector de mensajes de sistema de `features/hook-message-injector/` es un helper de soporte consumido por otros hooks y no expone comportamiento propio; viaja con los hooks que lo usan.",
    futureEvidence: "contract:qa-v2-hook-message-injector-contract.mjs",
  },
  "mcp-oauth": {
    classification: "Migrar",
    rationale:
      "El flujo OAuth 2.0 con PKCE, DCR y step-up de `features/mcp-oauth/` sobre `packages/mcp-client-core/` se migra como parte del sistema MCP de tres niveles de V2 con la misma seguridad.",
    futureEvidence: "task:14",
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
    futureEvidence: "contract:qa-v2-native-edition-nudge-contract.mjs",
  },
  "opencode-runtime-skills": {
    classification: "Migrar",
    rationale:
      "La fuente de skills de seguridad en runtime de `features/opencode-runtime-skills/`, que selecciona skills y las sirve por sesión sobre `packages/skills-loader-core/`, se migra al runtime nativo como fuente de skills de sesión.",
    futureEvidence: "task:14",
  },
  "opencode-skill-loader": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El descubrimiento de skills de cuatro ámbitos con prioridad numérica de `features/opencode-skill-loader/` sobre `packages/skills-loader-core/` se migra para alimentar las herramientas `skill` y `skill_mcp` nativas.",
    futureEvidence: "task:14",
  },
  "opengateway-provider": {
    classification: "Migrar",
    rationale:
      "La inyección del proveedor OpenGateway de `features/opengateway-provider/`, activada solo con credencial real y con el catálogo empaquetado, se migra al modelo de configuración de proveedores de V2.",
    futureEvidence: "contract:qa-v2-opengateway-provider-contract.mjs",
  },
  "run-continuation-state": {
    classification: "Migrar",
    rationale:
      "Los marcadores persistentes de continuación de `features/run-continuation-state/` que sostienen al subcomando `run` entre invocaciones se migran al estado de continuación del runtime nativo V2.",
    futureEvidence: "task:20",
  },
  "skill-mcp-manager": {
    classification: "Migrar",
    rationale:
      "El ciclo de vida de MCP de tier 3 de `features/skill-mcp-manager/` sobre `packages/mcp-client-core/`, aislado por la clave `${sessionID}:${skillName}:${serverName}`, se migra para el MCP embebido en skills con transporte stdio y HTTP.",
    futureEvidence: "task:14",
  },
  "task-toast-manager": {
    classification: "Migrar",
    rationale:
      "El gestor de notificaciones de progreso de tareas de `features/task-toast-manager/` se migra a los avisos de la TUI de V2 conservando el seguimiento de estado y la información de fallback de modelo.",
    futureEvidence: "contract:qa-v2-task-toast-contract.mjs",
  },
  "team-mode": {
    classification: "Migrar",
    rationale:
      "La coordinación multiagente paralela de `features/team-mode/` con primitivas de dominio en `packages/team-core/` se migra completa, incluidas las 12 herramientas `team_*`, el mailbox, el tasklist y su gate de configuración.",
    futureEvidence: "contract:qa-v2-team-mode-contract.mjs",
  },
  "tmux-subagent": {
    classification: "Migrar",
    rationale:
      "La orquestación de paneles tmux de `features/tmux-subagent/` sobre `packages/tmux-core/`, con seguimiento de sesiones y decisiones de panel, se migra para la visualización opcional de subagentes en V2.",
    futureEvidence: "task:16",
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
