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
    rationale:
      "La recuperación V1 en `hooks/anthropic-context-window-limit-recovery/recovery-hook.ts` aplica truncación, resumen y deduplicación ante errores de límite de contexto; se migra suscribiéndose a los eventos de error de sesión del runtime nativo V2 y aplicando las mismas estrategias sobre el estado de la sesión.",
    futureEvidence: "task:18",
  },
  "ast-grep-sg-provision": {
    classification: "Interno de build (sin superficie de runtime)",
    rationale:
      "La provisión V1 en `hooks/ast-grep-sg-provision/hook.ts` asegura el binario sg que consume la skill ast-grep; en el espejo se resuelve al preparar el runtime y viaja con la entrega de skills, sin exponer comportamiento propio de agente.",
    futureEvidence: "task:14",
  },
  atlas: {
    classification: "Migrar",
    rationale:
      "El orquestador V1 en `hooks/atlas/atlas-hook.ts` gobierna las sesiones boulder y background; se migra al runtime nativo V2 con suscripción a los eventos de sesión y guardas en tool.execute.before/after para la continuación y el auto-commit.",
    futureEvidence: "task:20",
  },
  "auto-slash-command": {
    classification: "Migrar",
    rationale:
      "El ejecutor V1 en `hooks/auto-slash-command/hook.ts` detecta y ejecuta comandos embebidos en el mensaje del usuario; se migra al modelo de comandos nativo de V2 con despacho desde el runtime, cubriendo los comandos de skill y de plugin.",
    futureEvidence: "task:14",
  },
  "auto-update-checker": {
    classification: "Migrar",
    rationale:
      "El chequeo V1 en `hooks/auto-update-checker/hook.ts` concentra los avisos de versión, configuración y proveedores en el arranque; se migra al init del runtime nativo V2 reproduciendo los toasts y el diagnóstico de inicio.",
    futureEvidence: "task:20",
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
    rationale:
      "El despachador V1 en `hooks/claude-code-hooks/claude-code-hooks-hook.ts` ejecuta hooks configurados de Claude Code en mensajes, tools y compactación; se migra reutilizando claude-code-compat-core y suscribiéndose a los eventos equivalentes del runtime nativo V2.",
    futureEvidence: "task:20",
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
    rationale:
      "El reintento V1 en `hooks/delegate-task-retry/hook.ts` reintenta delegaciones fallidas sobre el resultado de la herramienta; se migra al runtime nativo V2 en tool.execute.after con los mismos patrones de fallo.",
    futureEvidence: "task:20",
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
    rationale:
      "El aviso V1 en `hooks/fsync-skip-warning/index.ts` advierte cuando se omite fsync en una escritura atómica; se migra al runtime nativo V2 en tool.execute.after examinando el resultado de la escritura.",
    futureEvidence: "task:20",
  },
  goal: {
    classification: "Migrar",
    status: "Migrado parcialmente",
    rationale:
      "El objetivo persistente V1 en `hooks/goal/index.ts` gobierna la continuidad por idle y el uso por sesión; se migra al runtime nativo V2 con estado por sessionID, suscripción al evento de idle y las herramientas create_goal, update_goal y get_goal bajo el gate goal.enabled.",
    futureEvidence: "task:16",
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
    futureEvidence: "task:16",
  },
  "json-error-recovery": {
    classification: "Equivale a builtin V2",
    status: "Migrado",
    rationale:
      "V1 hook `hooks/json-error-recovery/hook.ts` appends a model-visible reminder when a tool result carries a JSON parse error. In V2 the host plugin `opencode.tool.input.repair` (decompiled from the v2.0.22 binary) normalizes tool arguments at execute.before (stringified objects/arrays are parsed, string numbers/booleans coerced), so the malformed-argument case never becomes a tool result and no observable event reaches the runtime. RAW lab evidence (opencode-v2-lab.service): over real sessions every tool call arrives as a parsed object; the model never emits string/malformed arguments (explicit attempts refused); and a JSON string injected by the runtime's execute.before was NOT repaired and the tool errored, so the native hook cannot be the observer and has no trigger. The V1-shaped extraction is retained only as a defensive after-result fallback.",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/json-input-recovery/",
  },
  "legacy-plugin-toast": {
    classification: "Migrar",
    rationale:
      "El aviso V1 en `hooks/legacy-plugin-toast/hook.ts` detecta y migra un entrypoint de plugin legacy; se migra al arranque del runtime nativo V2 reutilizando el motor de migración de configuración y avisando por toast.",
    futureEvidence: "task:25",
  },
  "model-fallback": {
    classification: "Migrar",
    rationale:
      "La cadena proactiva V1 en `hooks/model-fallback/hook.ts` reescribe el modelo en chat.params; se migra resolviendo la cadena por agente en la frontera http.request del runtime nativo V2 y reescribiendo el campo model del payload.",
    futureEvidence: "task:8",
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
    rationale:
      "El guard V1 en `hooks/no-hephaestus-non-gpt/hook.ts` restringe Hephaestus a modelos GPT; se migra con el gate de proveedor del roster V2 (requiresProvider e isHephaestusSupportedModel) al registrar el agente.",
    futureEvidence: "task:11",
  },
  "no-sisyphus-gpt": {
    classification: "Migrar",
    rationale:
      "El guard V1 en `hooks/no-sisyphus-gpt/hook.ts` bloquea Sisyphus en proveedores no GPT; se migra al runtime nativo V2 resolviendo el proveedor del modelo en la frontera http.request y denegando o avisando por toast.",
    futureEvidence: "task:8",
  },
  "notepad-write-guard": {
    classification: "Migrar",
    rationale:
      "El guard V1 en `hooks/notepad-write-guard/index.ts` bloquea escrituras a rutas de notepad append-only; se migra al runtime nativo V2 como guard en tool.execute.before con las mismas rutas bloqueadas.",
    futureEvidence: "task:20",
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
    rationale:
      "El truncador V1 en `hooks/question-label-truncator/hook.ts` acorta etiquetas largas de la herramienta de pregunta; se migra al runtime nativo V2 en tool.execute.before con el mismo límite.",
    futureEvidence: "task:20",
  },
  "read-image-resizer": {
    classification: "Migrar",
    rationale:
      "El redimensionador V1 en `hooks/read-image-resizer/hook.ts` reduce las imágenes grandes que se leen; se migra al runtime nativo V2 en tool.execute.after reescribiendo el resultado con la imagen reducida.",
    futureEvidence: "task:20",
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
    rationale:
      "El fallback reactivo V1 en `hooks/runtime-fallback/hook.ts` reacciona a los errores del proveedor; se migra al runtime nativo V2 suscribiéndose a los eventos de error de sesión y reintentando con el siguiente escalón.",
    futureEvidence: "task:8",
  },
  "sisyphus-junior-notepad": {
    classification: "Migrar",
    rationale:
      "La inyección V1 en `hooks/sisyphus-junior-notepad/hook.ts` añade el notepad al prompt del subagente; se migra al runtime nativo V2 como contexto de delegación al crear la sesión hija.",
    futureEvidence: "task:20",
  },
  "stop-continuation-guard": {
    classification: "Migrar",
    rationale:
      "El guard V1 en `hooks/stop-continuation-guard/hook.ts` atiende el comando de parada y detiene la continuidad; se migra al modelo de comandos nativo de V2 con el mismo estado de parada por sessionID.",
    futureEvidence: "task:20",
  },
  "tasks-todowrite-disabler": {
    classification: "Equivale a builtin V2",
    rationale:
      "El bloqueo V1 en `hooks/tasks-todowrite-disabler/hook.ts` desactiva todowrite cuando el sistema de tareas está activo; V2 no publica todowrite, así que el comportamiento queda cubierto por el host y el sistema de tareas migrado conserva el flujo.",
    futureEvidence: "contract:qa-v2-compaction-hook-contract.mjs",
  },
  "team-mailbox-injector": {
    classification: "Migrar",
    rationale:
      "El inyector V1 en `hooks/team-mailbox-injector/hook.ts` incorpora los mensajes pendientes del buzón del equipo; se migra al runtime nativo V2 leyendo el buzón por sessionID e inyectando los mensajes en la frontera http.request bajo el gate team_mode.enabled.",
    futureEvidence: "gate:team_mode.enabled",
  },
  "team-mode-status-injector": {
    classification: "Migrar",
    rationale:
      "El inyector V1 en `hooks/team-mode-status-injector/hook.ts` publica el bloque de estado del equipo en los mensajes; se migra inyectándolo en la frontera http.request del runtime nativo V2 bajo el gate team_mode.enabled.",
    futureEvidence: "gate:team_mode.enabled",
  },
  "team-tool-gating": {
    classification: "Migrar",
    rationale:
      "El gate V1 en `hooks/team-tool-gating/hook.ts` restringe las herramientas de equipo según el rol del miembro; team mode se migra completo, así que se porta al runtime nativo V2 como guard en tool.execute.before bajo el gate team_mode.enabled.",
    futureEvidence: "gate:team_mode.enabled",
  },
  "todo-description-override": {
    classification: "Migrar",
    rationale:
      "El override V1 en `hooks/todo-description-override/hook.ts` reescribe descripciones de todos; se migra al runtime nativo V2 sobre el registro de todos por sessionID en tool.execute.before y after.",
    futureEvidence: "task:20",
  },
  "tool-pair-validator": {
    classification: "Migrar",
    rationale:
      "El validador V1 en `hooks/tool-pair-validator/hook.ts` repara pares de llamada y resultado de herramienta desemparejados; se migra en la frontera http.request del runtime nativo V2, reparando los mensajes antes de enviarlos al proveedor.",
    futureEvidence: "task:20",
  },
  "ulw-execute": {
    classification: "Migrar",
    rationale:
      "El comando V1 en `hooks/ulw-execute/ulw-execute-hook.ts` arranca una sesión de trabajo de Atlas con contexto de boulder y worktree; se migra al modelo de comandos nativo de V2 y al contexto de sesión del runtime.",
    futureEvidence: "task:20",
  },
  "unstable-agent-babysitter": {
    classification: "Migrar",
    rationale:
      "El vigilante V1 en `hooks/unstable-agent-babysitter/unstable-agent-babysitter-hook.ts` analiza mensajes de subagentes inestables y añade un recordatorio; se migra al runtime nativo V2 suscribiéndose al idle de sesión y transformando los mensajes.",
    futureEvidence: "task:20",
  },
  "webfetch-redirect-guard": {
    classification: "Migrar",
    rationale:
      "V1 guard in `hooks/webfetch-redirect-guard/hook.ts` resolves and bounds webfetch redirects; the native V2 runtime replicates `resolveWebFetchRedirects` (max 10, statuses 301/302/303/307/308, normalized timeout) in tool.execute.before/after, tested against a real local HTTP server.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
}
