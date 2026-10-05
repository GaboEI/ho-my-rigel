// Clasificación de migración de los hooks V1 con destino pendiente (tarea 7).
// Cada fila mapea el hook V1 a Migrar, Adaptar, Equivale a builtin V2 o
// Interno de build (sin superficie de runtime), con su rationale y la evidencia
// futura (tarea, contrato o gate) que demostrará la equivalencia.
export default {
  "agent-usage-reminder": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/agent-usage-reminder/` decora el resultado de una herramienta de búsqueda o fetch dirigida a un agente orquestador, se detiene tras usar una herramienta de delegación y limita el aviso a tres veces por sesión. El reemplazo nativo en `rigel-v2-native-reminders.mjs` reproduce el conjunto exacto de orquestadores, el mensaje byte a byte, el tope de MAX 3, el conteo de diez herramientas no-task y la persistencia por sessionID mediante storage inyectado (get/set/delete), con la continuidad tras reinicio comprobada por prueba.",
    futureEvidence: "`rigel-v2-native-reminders.mjs`; `rigel-v2-native-reminders.test.mjs`",
  },
  "anthropic-context-window-limit-recovery": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La recuperación V1 ante límite de contexto se adapta a `ctx.session.compact`: `rigel-v2-native-phase4-events.mjs` reconoce el error de límite, solicita una compactación V2 una sola vez por incidente y libera el dedupe al terminar o borrar la sesión.",
    futureEvidence: "`rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-phase4-events.test.mjs`; OpenCode V2 Plugins API: `ctx.session.compact`",
  },
  "ast-grep-sg-provision": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "unwired upstream",
    rationale:
      "La provision V1 en `hooks/ast-grep-sg-provision/hook.ts` asegura el binario sg que consume la skill ast-grep; el perfil gabo no incluye la skill ast-grep y skills-loader-core no la expone como builtin del bundle nativo, asi que la provision no tiene consumidor en este perfil y queda desconectada hasta que la skill viaje con el kit.",
    futureEvidence: "contract:profiles/gabo/skills (sin skill ast-grep en el kit); packages/skills-loader-core",
  },
  atlas: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El trabajo Atlas V1 se entrega por `/ulw-execute` con estado boulder durable y por la continuación nativa de idle: `rigel-v2-native-phase4-events.mjs` detecta trabajo background activo del orquestador y entrega una continuación sintética mediante la API V2.",
    futureEvidence: "`rigel-v2-ulw-execute.mjs`; `rigel-v2-ulw-execute.test.mjs`; `rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-phase4-events.test.mjs`",
  },
  "auto-slash-command": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El ejecutor V1 en `hooks/auto-slash-command/hook.ts` detecta y ejecuta comandos embebidos en el mensaje del usuario, cubriendo los comandos de skill y de plugin. El puerto nativo corre sobre el seam oficial de admisión de prompts de V2 (`ctx.session.hook(\"prompt\")`, draft canónico mutable), con detector, ejecutor, dedupe y el puente skill-command propios.",
    futureEvidence:
      "`rigel-v2-auto-slash-command-bridge.mjs`; `rigel-v2-auto-slash-command-bridge.test.mjs`; `rigel-v2-native.mjs` (hook prompt); `live-qa/wave3-auto-slash.md`",
  },
  "auto-update-checker": {
    classification: "Migrar",
    status: "Incompatible (con evidencia)",
    rationale:
      "El chequeo V1 instala o consulta actualizaciones y publica toasts de versión. La API oficial de plugins V2 publica transformaciones, hooks, sesiones, herramientas y eventos, pero no una API de actualización ni de toast; no existe una superficie V2 segura para reproducir ese efecto del host.",
    futureEvidence: "OpenCode V2 Plugins API: Overview/API/Hooks, sin servicio de actualización ni toast; incompatibilidad explícita, no un puntero a tarea cerrada.",
  },
  "category-skill-reminder": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El recordatorio V1 en `hooks/category-skill-reminder/` avisa cargar skills tras tres herramientas delegables sin delegar, una vez por sesión. El reemplazo nativo en `rigel-v2-native-category-skill-reminder.mjs` conserva el conjunto de agentes objetivo, el umbral de tres, la supresión por delegación, el formateador byte a byte y el consumo único; `rigel-v2-native-prompt.mjs` lee `pending` y llama `consume` en la frontera http.request del orquestador sin mutar el resultado de la herramienta.",
    futureEvidence: "`rigel-v2-native-category-skill-reminder.mjs`; `rigel-v2-native-category-skill-reminder.test.mjs`; `rigel-v2-native-prompt.mjs`",
  },
  "claude-code-hooks": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El despachador V1 se adapta con `createNativeClaudeCodeHooks`, que registra prompt, compactación y hooks before/after de herramientas y consume SessionStart/Stop desde la suscripción V2; sus salidas de prompt llegan al colector de contexto nativo.",
    futureEvidence:
      "`rigel-v2-claude-code-hooks.mjs`; `rigel-v2-claude-code-hooks.test.mjs`; `rigel-v2-context-collector.mjs`",
  },
  "comment-checker": {
    classification: "Migrar",
    rationale:
      "V1 guard in `hooks/comment-checker/hook.ts` invokes the real binary (`check`, JSON on stdin, exit 0 clean / exit 2 comments); the native V2 runtime replicates the protocol from tool.execute.after against the cached binary (0.8.0 marker) and IMPLEMENTS both `// @allow` and `// comment-checker-disable-file` in the native layer, which the 0.8.0 binary does not honor by itself. Both bypasses are LIVE-PROVEN in the lab (file-disable vs control: control warned, disabled not; @allow: not warned) and covered by positive/negative contracts for write, edit and multiedit.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "delegate-task-retry": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El reintento V1 en `hooks/delegate-task-retry/hook.ts` reintenta delegaciones fallidas sobre el resultado de la herramienta. El core puro `rigel-v2-delegate-retry-core.mjs` porta el clasificador de fallos y la decision de reintento, y `rigel-v2-native-flow-after.mjs` lo monta como regla `tool.execute.after` compuesta en `rigel-v2-native-flow-rules.mjs`; la secuencia observada del runtime incluye `delegate-task-retry` en la cadena after.",
    futureEvidence:
      "`rigel-v2-native-flow-after.mjs`; `rigel-v2-delegate-retry-core.mjs`; `rigel-v2-native-flow-after.test.mjs`; `rigel-v2-delegate-retry-oracle.test.mjs`",
  },
  "directory-agents-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/directory-agents-injector/` descubre los `AGENTS.md` aplicables a una lectura y los anexa al resultado de lectura (`output.output +=`). El reemplazo nativo en `rigel-v2-directory-instructions.mjs` reproduce el recorrido hacia arriba con `skipRoot`, el orden raiz primero, la contencion canonica por realpath, la deduplicacion por directorio y la truncacion por tokens, y anexa el sobre `<rigel-native-directory-agents>` al mismo resultado de lectura en `tool.execute.after`.",
    futureEvidence: "`rigel-v2-directory-instructions.mjs`; `rigel-v2-directory-instructions.test.mjs`",
  },
  "directory-readme-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/directory-readme-injector/` conserva los `README.md` aplicables a una lectura y los anexa al resultado de lectura. El mismo almacen nativo en `rigel-v2-directory-instructions.mjs` recorre los README incluido el de la raiz del workspace, aplica el orden raiz primero, la deduplicacion por directorio y la truncacion por tokens, y anexa el bloque al mismo resultado de lectura en `tool.execute.after`.",
    futureEvidence: "`rigel-v2-directory-instructions.mjs`; `rigel-v2-directory-instructions.test.mjs`",
  },
  "fsync-skip-warning": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El aviso V1 en `hooks/fsync-skip-warning/index.ts` advierte cuando se omite fsync en una escritura atomica. `rigel-v2-native-flow-after.mjs` monta las reglas `fsync-skip-warning:record-start` (before) y `fsync-skip-warning` (after) sobre el clasificador puro de `rigel-v2-flow-logic.mjs`, con un unico tracker inyectado por `createFlowRules`.",
    futureEvidence:
      "`rigel-v2-native-flow-after.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-after.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  goal: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El objetivo persistente V1 en `hooks/goal/index.ts` gobierna la continuidad por idle y el uso por sesión; se migra al runtime nativo V2 con estado por sessionID, suscripción al evento de idle y las herramientas create_goal, update_goal y get_goal bajo el gate goal.enabled.",
    futureEvidence: "tools/goal.tools.mjs; rigel-v2-native.mjs (comando goal + onStop); rigel-v2-native-conditional-tools.mjs; live-qa/wave1-goal.md",
  },
  "hashline-read-enhancer": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El enhancer V1 en `hooks/hashline-read-enhancer/hook.ts` etiqueta cada lectura con LINE#ID. La superficie V2 mutable de `tool.execute.after` permite portarlo directamente: `createHashlineReadEnhancer` en `rigel-v2-native-hashline.mjs` reescribe el contenido del resultado de lectura (cabecera `Read file ...` incluida) con LINE#ID y reescribe el marcador de escritura. La paridad con `hashline-core` de V1 está fijada por prueba y la ejecución viva lo comprueba en la sesión del laboratorio.",
    futureEvidence: "`rigel-v2-native-hashline.mjs`; `rigel-v2-native-hashline.test.mjs`",
  },
  "interactive-bash-session": {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "La sesión V1 en `hooks/interactive-bash-session/hook.ts` gestiona el ciclo de vida tmux de interactive_bash; se migra al runtime nativo V2 cuando tmux está disponible, replicando el tracker y el estado por sesión.",
    futureEvidence: "`tools/interactive-bash.tools.mjs`; `rigel-v2-native-conditional-tools.mjs`",
  },
  "json-error-recovery": {
    classification: "Equivale a builtin V2",
    status: "Migrado",
    rationale:
      "V1 hook `hooks/json-error-recovery/hook.ts` appends a model-visible reminder when a tool result carries a JSON parse error. In V2 the host plugin `opencode.tool.input.repair` (decompiled from the v2.0.22 binary) normalizes tool arguments at execute.before (stringified objects/arrays are parsed, string numbers/booleans coerced), so the malformed-argument case never becomes a tool result and no observable event reaches the runtime. RAW lab evidence (opencode-v2-lab.service): over real sessions every tool call arrives as a parsed object; the model never emits string/malformed arguments (explicit attempts refused); and a JSON string injected by the runtime's execute.before was NOT repaired and the tool errored, so the native hook cannot be the observer and has no trigger. The V1-shaped extraction is retained only as a defensive after-result fallback.",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/json-input-recovery/",
  },
  "keyword-detector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El detector V1 en `hooks/keyword-detector/` decide e inyecta las guias de `ultrawork`/`ulw`, team mode, `hyperplan` y el combo `hyperplan`+`ultrawork`. El core puro `rigel-v2-keyword-core.mjs` reproduce el orden de filtros, las regexes exactas (incluidas la negacion `interface.hpp` y la correccion de `ultraworker`), la interseccion de deshabilitados, la allowlist, la supresion del combo, el enrutado por fuente (planner/gpt/gemini/glm/default), el replay y la restauracion tras compactacion. `rigel-v2-native-keyword-seam.mjs` lo enlaza a la frontera verificada `http.request` de V2 sobre `body.messages[role=user].content`, con `rigel-v2-keyword-state.mjs` (tope 256 FIFO, clear en `session.deleted`) y los cuerpos V1 por tipo staged desde `rigel-v2-native-prompt.mjs`; el drive staged prueba la cadena completa.",
    futureEvidence:
      "`rigel-v2-keyword-core.mjs`; `rigel-v2-keyword-state.mjs`; `rigel-v2-native-keyword-seam.mjs`; `rigel-v2-native-prompt.mjs`; `rigel-v2-keyword-core.test.mjs`; `rigel-v2-keyword-state.test.mjs`; `rigel-v2-native-prompt.test.mjs`",
  },
  "legacy-plugin-toast": {
    classification: "Migrar",
    rationale:
      "El aviso V1 en `hooks/legacy-plugin-toast/hook.ts` detecta y migra un entrypoint de plugin legacy; se migra al arranque del runtime nativo V2 reutilizando el motor de migración de configuración y avisando por toast.",
    futureEvidence: "task:25",
  },
  "model-fallback": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La cadena proactiva V1 en `hooks/model-fallback/hook.ts` reescribe el modelo en chat.params; se migra resolviendo la cadena por agente en la frontera http.request del runtime nativo V2 y reescribiendo el campo model del payload.",
    futureEvidence: "`rigel-v2-native-model-chains.mjs`; `rigel-v2-native-model-chains.test.mjs`; `rigel-v2-native.mjs` (fallback proactivo en model.request y reactivo en session.error)",
  },
  "monitor-status-injector": {
    classification: "Migrar",
    rationale:
      "El inyector V1 en `hooks/monitor-status-injector/hook.ts` añade el estado del monitor a los mensajes; se migra inyectando el bloque en la frontera http.request del runtime nativo V2, condicionado al gate monitor.enabled que está apagado por defecto.",
    futureEvidence: "gate:monitor.enabled",
  },
  "native-edition-nudge": {
    classification: "Migrar",
    rationale:
      "El nudge V1 en `hooks/native-edition-nudge/hook.ts` decide y muestra un aviso de una sola vez hacia la edición nativa; se migra al arranque del runtime nativo V2 con estado persistente y toast de inicio.",
    futureEvidence: "task:25",
  },
  "no-hephaestus-non-gpt": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El guard V1 en `hooks/no-hephaestus-non-gpt/hook.ts` restringe Hephaestus a modelos GPT; se migra con el gate de proveedor del roster V2 (requiresProvider e isHephaestusSupportedModel) al registrar el agente.",
    futureEvidence: "`rigel-v2-native-hephaestus.mjs`; `rigel-v2-native-hephaestus.test.mjs`",
  },
  "no-sisyphus-gpt": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El guard V1 en `hooks/no-sisyphus-gpt/hook.ts` bloquea Sisyphus en proveedores no GPT; en el runtime nativo la seleccion de modelos de cada agente pasa por las cadenas y gates del manifiesto (`requiresProvider`/gate por agente en el registro) y por el fallback de `rigel-v2-native-model-chains.mjs`, que nunca resuelve a un modelo fuera de la cadena del agente.",
    futureEvidence: "`rigel-v2-native-model-chains.mjs`; `rigel-v2-native-hephaestus.mjs` (gate equivalente); `rigel-v2-native-agents.mjs`",
  },
  "notepad-write-guard": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El guard V1 en `hooks/notepad-write-guard/index.ts` bloquea escrituras a rutas de notepad append-only. `rigel-v2-native-flow-guards.mjs` monta la regla `notepad-write-guard` en `tool.execute.before` sobre la logica pura de rutas de `rigel-v2-flow-logic.mjs`, con la misma decision de bloqueo; la prueba de aislamiento del bastidor before la ejercita.",
    futureEvidence:
      "`rigel-v2-native-flow-guards.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-guards.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  "plan-format-validator": {
    classification: "Migrar",
    rationale:
      "V1 validator in `hooks/plan-format-validator/hook.ts` checks checkbox format in boulder plans; the native V2 runtime runs it in tool.execute.after on Write/Edit of `.omo/plans/*.md`, rewrites `**Effort:** <duration>` to its band and appends the malformed-row warning. Parity with `boulder-state` is pinned by test.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "prometheus-md-only": {
    classification: "Migrar",
    rationale:
      "V1 guard in `hooks/prometheus-md-only/hook.ts` restricts Prometheus to writing only .md files; the native V2 runtime runs it in tool.execute.before with the same path policy (`isAllowedFile`: confinement, `.omo` segment, `.md` extension) and the session-resolved agent matcher.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "question-label-truncator": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El truncador V1 en `hooks/question-label-truncator/hook.ts` acorta etiquetas largas de la herramienta de pregunta. `rigel-v2-native-flow-guards.mjs` aplica el mismo limite en `tool.execute.before` sobre la logica pura de `rigel-v2-flow-logic.mjs`.",
    futureEvidence:
      "`rigel-v2-native-flow-guards.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-guards.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  "read-image-resizer": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El redimensionador V1 real (`hooks/read-image-resizer/hook.ts`) se migra a la frontera V2 comprobada `session.hook(\"http.request\")` como `imageResizerStep` en `rigel-v2-native-request-steps.mjs`. El cuerpo saliente lleva las imagenes como data URL (`body.messages` chat, `body.input` responses); el gate V1 `providerID === \"anthropic\"` se conserva por defecto (`RIGEL_IMAGE_RESIZER_PROVIDERS` solo para QA viva) y `rigel-v2-native-image-resizer.mjs` decodifica, redimensiona y re-codifica con el `Bun.Image` del runtime (Bun 1.4.2 embebido en el binario V2.0.22) respetando los limites de 1568px y 5MB, con reintento de calidad para jpeg/webp. Los parsers y el calculo de dimensiones siguen anclados a los duenos V1.",
    futureEvidence:
      "`rigel-v2-native-image-resizer.mjs`; `rigel-v2-native-request-steps.mjs`; `rigel-v2-native-image-resizer.test.mjs`; `rigel-v2-native-request-steps.test.mjs`",
  },
  "rules-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/rules-injector/` descubre reglas de proyecto y de usuario y las anexa al resultado de la herramienta. El reemplazo nativo en `rigel-v2-native-rules.mjs` porta el descubrimiento por marcador de raíz, el recorrido por ancestros con orden por distancia, el parser de frontmatter, el matcher de globs, el truncador por tokens y la deduplicación por sesión con `clear` en compactación. La prueba fija la paridad del matcher con picomatch en modo dot+bash sobre un corpus de globs, clases de caracteres, llaves y negaciones.",
    futureEvidence: "`rigel-v2-native-rules.mjs`; `rigel-v2-native-rules.test.mjs`",
  },
  "runtime-fallback": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El fallback reactivo V1 reacciona a los errores del proveedor; el port nativo marca el modelo fallido en los eventos `session.execution.failed`/`session.error` y resuelve el siguiente escalon con `switchModel` (pre-seleccion, permite cambiar proveedor) via `applyReactiveFallback`.",
    futureEvidence: "`rigel-v2-native-model-chains.mjs`; `rigel-v2-native.mjs` (applyReactiveFallback en el bucle de eventos); `rigel-v2-native-model-chains.test.mjs`",
  },
  "sisyphus-junior-notepad": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/sisyphus-junior-notepad/hook.ts` inyecta el notepad al prompt del subagente. `rigel-v2-native-flow-guards.mjs` monta la regla en `tool.execute.before` sobre la decision pura de `rigel-v2-flow-logic.mjs`, reproduciendo la eleccion de inyeccion del notepad cuando la delegacion crea un hijo; la secuencia before observada del runtime la incluye.",
    futureEvidence:
      "`rigel-v2-native-flow-guards.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-guards.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  "stop-continuation-guard": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El guard V1 en `hooks/stop-continuation-guard/hook.ts` atiende el comando de parada, cancela las tareas background descendientes en estado running/pending y escribe el marcador de continuacion `stop`. V2 no expone `command.execute.before`, asi que el paso `stop-continuation-guard` de `rigel-v2-native-request-steps.mjs` observa el ultimo mensaje de usuario en la frontera `http.request`, marca la sesion detenida y elimina cualquier continuacion encolada; en la remediacion de la auditoria de Fase 4 el runtime ademas cancela los descendientes (queued/starting/running) via `rigel-v2-background-manager.mjs` y escribe/limpia el marcador `sources.stop` (`.omo/run-continuation/<sessionID>.json`) via `rigel-v2-background-marker.mjs`; el estado se limpia en `session.deleted`.",
    futureEvidence:
      "`rigel-v2-native-request-steps.mjs`; `rigel-v2-native-request-steps.test.mjs`; `rigel-v2-background-manager.mjs`; `rigel-v2-background-manager.test.mjs`; `.omo/evidence/20261005-phase4-audit-remediation/task-r1.txt`",
  },
  "tasks-todowrite-disabler": {
    classification: "Equivale a builtin V2",
    rationale:
      "El bloqueo V1 en `hooks/tasks-todowrite-disabler/hook.ts` desactiva todowrite cuando el sistema de tareas está activo; V2 no publica todowrite, así que el comportamiento queda cubierto por el host y el sistema de tareas migrado conserva el flujo.",
    futureEvidence: "contract:qa-v2-compaction-hook-contract.mjs",
  },
  "team-mailbox-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El inyector V1 incorpora los mensajes pendientes del buzon en el turno. El port nativo inyecta un bloque `<team-mailbox>` con los mensajes no leidos del miembro y los marca leidos (la inyeccion ES la entrega), sobre el hook `context` de V2 bajo el gate team_mode.",
    futureEvidence: "`rigel-v2-team-gating.mjs` (createNativeTeamMailboxInjector); `rigel-v2-team-gating.test.mjs`; `rigel-v2-native.mjs` (hook context)",
  },
  "team-mode-status-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El inyector V1 incorpora el estado del equipo en el turno. El port nativo inyecta un bloque `<team-status>` (estado del team y de cada miembro) en el ultimo mensaje de usuario real via el hook `context` de V2, para cualquier participante (lead o miembro), bajo el gate team_mode.",
    futureEvidence: "`rigel-v2-team-gating.mjs` (createNativeTeamStatusInjector); `rigel-v2-team-gating.test.mjs`; `rigel-v2-native.mjs` (hook context)",
  },
  "team-tool-gating": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El gate V1 en `hooks/team-tool-gating/hook.ts` restringe las herramientas de equipo segun el rol. La regla nativa corre en la cadena `execute.before` de V2 bajo el gate team_mode: team_create denegado a participantes, delete/shutdown_request solo lead, approve/reject participantes, herramientas universales solo participantes del team nombrado; la denegacion lanza y bloquea la llamada.",
    futureEvidence: "`rigel-v2-team-gating.mjs` (createNativeTeamGatingRule); `rigel-v2-team-gating.test.mjs`; `rigel-v2-native.mjs` (nativeBeforeRules)",
  },
  "todo-description-override": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El override V1 (`hooks/todo-description-override/hook.ts`, hook `tool.definition`) se entrega en V2 registrando un `todowrite` real cuyo `description` ES el texto V1 `TODOWRITE_DESCRIPTION` (`rigel-v2-native-todo-description.mjs`, cableado en `rigel-v2-native.mjs`), respaldado por el store de todos por sesion del runtime. La definicion registrada es lo que el host convierte en el schema de tools del modelo, de modo que la descripcion V1 llega al modelo. El veredicto previo de que `tool.transform` era add-only era incorrecto: el editor expone add/get/update/list/namespace/remove, y `todowrite` no es un builtin de V2.",
    futureEvidence:
      "`rigel-v2-native-todo-description.mjs`; `rigel-v2-native-todo-description.test.mjs`; `rigel-v2-native.mjs`",
  },
  "tool-pair-validator": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El validador V1 en `hooks/tool-pair-validator/hook.ts` repara pares de llamada y resultado de herramienta desemparejados. El paso `tool-pair-validator` de `rigel-v2-native-request-steps.mjs` repara ambos formatos (Chat Completions `body.messages` y OpenAI Responses `body.input`) insertando el resultado terminal con `INTERRUPTED_TOOL_ERROR`, de forma idempotente, en la unica frontera `http.request`.",
    futureEvidence:
      "`rigel-v2-native-request-steps.mjs`; `rigel-v2-native-request-steps.test.mjs`",
  },
  "ulw-execute": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El comando V1 se entrega como comando V2 `/ulw-execute`: crea o reanuda estado boulder durable, selecciona plan, prepara notepads, cambia al agente Atlas cuando está disponible y entrega el contexto sin duplicarlo.",
    futureEvidence:
      "`rigel-v2-ulw-execute.mjs`; `rigel-v2-ulw-execute.test.mjs`; registro `context.command.transform` en `rigel-v2-native.mjs`",
  },
  "unstable-agent-babysitter": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El vigilante V1 se adapta al estado durable de hijos V2: en idle, `rigel-v2-native-phase4-events.mjs` consulta el conteo background del padre y entrega una advertencia sintética una sola vez hasta limpiar la sesión.",
    futureEvidence: "`rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-phase4-events.test.mjs`; `rigel-v2-background-manager.mjs`",
  },
  "webfetch-redirect-guard": {
    classification: "Migrar",
    rationale:
      "V1 guard in `hooks/webfetch-redirect-guard/hook.ts` resolves and bounds webfetch redirects; the native V2 runtime replicates `resolveWebFetchRedirects` (max 10, statuses 301/302/303/307/308, normalized timeout) in tool.execute.before/after, tested against a real local HTTP server.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
}
