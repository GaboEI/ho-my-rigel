# Rigel: inventario de migración V1 a V2

> Estado: **no completado**. Este documento se genera desde las superficies reales de OmO V1. Ninguna fila marcada como pendiente puede presentarse como migrada.

## Regla de aceptación

Cada capacidad necesita: equivalente V2 identificado, prueba aislada contra OpenCode V2 real y evidencia de que no toca V1. Si V2 carece de API, la fila debe contener la incompatibilidad y la evidencia, no una simulación.

## Resumen de superficies conocidas

| Superficie | Estado | Alcance actual | Evidencia |
| --- | --- | --- | --- |
| Agentes seleccionados | Migrado parcialmente | `agent.transform` + `agent.reload`; falta auditar todos los modos y permisos | `qa-v2-agent-transform-contract.mjs` |
| Delegación nombrada | Migrado parcialmente | `rigel_task`; foreground, continuación y handoff básico en background probados; faltan paridad de categorías y la capa V1 de cola/reintento/deduplicación | `qa-v2-native-delegation.mjs` |
| chat.message | Migrado parcialmente | La superficie nativa V2 inyecta roster/ultrawork/directorio en la frontera http.request; la variante por turno es el muro documentado (evidencia histórica del puente en attic). Re-prueba nativa pendiente en Fase 4 | `rigel-v2-native-prompt.mjs`; `qa-v2-chat-message-contract.mjs` y `qa-v2-chat-message-variant-contract.mjs` (attic) |
| Instrucciones por directorio | Migrado parcialmente | La sustitución nativa conserva `AGENTS.md` y `README.md` aplicables tras una lectura V2, y el `AGENTS.md` raíz antes del primer turno de Hephaestus | `rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs` |
| Continuidad de compactación | Incompatible parcialmente | V2 conserva su resumen nativo, pero su hook de compactación no propaga contexto adicional al modelo; no se puede portar el inyector V1 sin sustituir el resumen | `qa-v2-compaction-hook-contract.mjs` |
| Keyword detector | Migrado parcialmente | Activación explícita `Ultraworker`/`ultrawork`/`ulw` y modo predeterminado, aislados de hijos, probados en V2; faltan team mode, Hyperplan, configuración de exclusión y recuperación tras compactación | `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs` |

## Composición de hooks en runtime (derivada del código)

Recuento derivado de los objetos de retorno de los compositores, no de la prosa del repositorio. Cada cifra es un recuento de **slots cableados registrados por el compositor**, incluidos los slots condicionados por configuración; no es un recuento de hooks activos por defecto. Base (team off, monitor off): **55**; solo team mode: **62**; solo monitor (team off): **56**; team mode + monitor: **63**.

| Tier | Base (team off, monitor off) | team mode | monitor (team off) | team mode + monitor | Hooks cableados (claves del compositor) |
| --- | --- | --- | --- | --- | --- |
| Session | 24 | 24 | 24 | 24 | `preemptiveCompaction`, `sessionNotification`, `thinkMode`, `modelFallback`, `anthropicContextWindowLimitRecovery`, `autoUpdateChecker`, `astGrepSgProvision`, `agentUsageReminder`, `nonInteractiveEnv`, `interactiveBashSession`, `goal`, `editErrorRecovery`, `delegateTaskRetry`, `ulwExecute`, `prometheusMdOnly`, `sisyphusJuniorNotepad`, `noSisyphusGpt`, `noHephaestusNonGpt`, `hephaestusAgentsMdInjector`, `questionLabelTruncator`, `taskResumeInfo`, `runtimeFallback`, `legacyPluginToast`, `nativeEditionNudge` |
| Tool guard | 17 | 18 | 17 | 18 | `commentChecker`, `toolOutputTruncator`, `directoryAgentsInjector`, `directoryReadmeInjector`, `emptyTaskResponseDetector`, `rulesInjector`, `tasksTodowriteDisabler`, `writeExistingFileGuard`, `bashFileReadGuard`, `hashlineReadEnhancer`, `jsonErrorRecovery`, `readImageResizer`, `todoDescriptionOverride`, `webfetchRedirectGuard`, `fsyncSkipWarning`, `teamToolGating`, `notepadWriteGuard`, `planFormatValidator` |
| Transform | 5 | 7 | 6 | 8 | `claudeCodeHooks`, `keywordDetector`, `btwSideContextInjector`, `contextInjectorMessagesTransform`, `teamModeStatusInjector`, `teamMailboxInjector`, `toolPairValidator`, `monitorStatusInjector` |
| Continuation | 7 | 7 | 7 | 7 | `stopContinuationGuard`, `compactionContextInjector`, `compactionTodoPreserver`, `todoContinuationEnforcer`, `unstableAgentBabysitter`, `backgroundNotificationHook`, `atlasHook` |
| Skill | 2 | 2 | 2 | 2 | `categorySkillReminder`, `autoSlashCommand` |
| Handlers de evento directos (`plugin/event.ts`) | 0 | 4 | 0 | 4 | `team-idle-wake-hint`, `team-lead-orphan-handler`, `team-member-error-handler`, `team-member-status-handler` |
| **Total** | **55** | **62** | **56** | **63** | |

Handlers enumerados fuera del escaneo de directorios de `hooks/`:

| Grupo | Handlers |
| --- | --- |
| Archivos sueltos en `hooks/` | `bash-file-read-guard`, `empty-task-response-detector`, `preemptive-compaction`, `session-notification`, `tool-output-truncator` |
| `hooks/team-session-events/` | `team-idle-wake-hint`, `team-lead-orphan-handler`, `team-member-error-handler`, `team-member-status-handler` |
| Transform hooks en `features/` | `btw-side`:`btwSideContextInjector`, `context-injector`:`contextInjectorMessagesTransform` |

Hooks no cableados upstream, excluidos del recuento cableado: `ralph-loop`, `task-reminder`.

## Hooks V1 (inventario de directorios, 54)

| Hook V1 | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `agent-usage-reminder` | Migrado parcialmente | El hook nativo V2 decora el mismo resultado de búsqueda para agentes orquestadores y se detiene tras `rigel_task`; falta la persistencia V1 tras reinicio. La mutabilidad real de `tool.execute.after` fue comprobada de forma aislada. `rigel-v2-native-reminders.mjs`; `rigel-v2-native-reminders.test.mjs`; `qa-v2-tool-after-result-contract.mjs` |
| `anthropic-context-window-limit-recovery` | Pendiente de clasificación V2 | - |
| `ast-grep-sg-provision` | Pendiente de clasificación V2 | - |
| `atlas` | Pendiente de clasificación V2 | - |
| `auto-slash-command` | Pendiente de clasificación V2 | - |
| `auto-update-checker` | Pendiente de clasificación V2 | - |
| `background-notification` | Migrado parcialmente | Suscripción V2 a eventos terminales y reanudación del padre; faltan cola, reintento y deduplicación del manager V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs` |
| `category-skill-reminder` | Pendiente de clasificación V2 | - |
| `claude-code-hooks` | Pendiente de clasificación V2 | - |
| `comment-checker` | Pendiente de clasificación V2 | - |
| `compaction-context-injector` | Incompatible (con evidencia) | V2.0.22 invoca `session.hook("compaction")`, pero las mutaciones de `event.system` no llegan a la petición real del proveedor que genera el resumen. No se usa `result`, pues reemplazaría el resumen nativo. `qa-v2-compaction-hook-contract.mjs` |
| `compaction-todo-preserver` | Incompatible (con evidencia) | La superficie V2 real de `context.session` no expone `todo`, y el catálogo de herramientas del turno V2 no contiene `todowrite`; por tanto no existe lectura ni escritura nativa de todos que permita preservar la lista V1. `qa-v2-compaction-hook-contract.mjs` |
| `delegate-task-retry` | Pendiente de clasificación V2 | - |
| `directory-agents-injector` | Migrado parcialmente | Hook V2 `tool.execute.after` recuerda los `AGENTS.md` aplicables a una lectura y los inyecta en la siguiente petición del mismo sessionID. Servidor V2 aislado comprobado. `rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs` |
| `directory-readme-injector` | Migrado parcialmente | El mismo hook V2 conserva los `README.md` aplicables a una lectura y los inyecta como contexto en la siguiente petición del mismo sessionID. Servidor V2 aislado comprobado. `rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs` |
| `edit-error-recovery` | Migrado parcialmente | El reemplazo V2 detecta los tres errores de Edit V1 y anexa la misma instrucción de recuperación al resultado de herramienta mutable. La mutabilidad se comprobó contra V2 aislado y los patrones mediante pruebas unitarias; falta provocar un fallo real del editor V2. `rigel-v2-native-recovery.mjs`; `rigel-v2-native-recovery.test.mjs`; `qa-v2-tool-after-result-contract.mjs` |
| `fsync-skip-warning` | Pendiente de clasificación V2 | - |
| `goal` | Pendiente de clasificación V2 | - |
| `hashline-read-enhancer` | Pendiente de clasificación V2 | - |
| `hephaestus-agents-md-injector` | Migrado parcialmente | Para cualquier manifiesto V2 que incluya Hephaestus, la petición inicial recibe el `AGENTS.md` raíz; contrato aislado V2 comprobado. El perfil de laboratorio de Gabo lo excluye de forma explícita, por lo que no es una capacidad visible allí. `rigel-v2-native.mjs`; `qa-v2-agents-md-contract.mjs`; `v2-agent-selection.json` |
| `interactive-bash-session` | Pendiente de clasificación V2 | - |
| `json-error-recovery` | Migrado parcialmente | El reemplazo V2 conserva patrones, exclusiones y deduplicación de la instrucción V1 sobre el resultado mutable. La mutabilidad se comprobó contra V2 aislado y los patrones mediante pruebas unitarias; falta provocar un error JSON real del host V2. `rigel-v2-native-recovery.mjs`; `rigel-v2-native-recovery.test.mjs`; `qa-v2-tool-after-result-contract.mjs` |
| `keyword-detector` | Migrado parcialmente | Activación explícita `Ultraworker`/`ultrawork`/`ulw` y modo predeterminado, aislados de hijos, probados en V2; faltan team mode, Hyperplan, configuración de exclusión y recuperación tras compactación. `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs` |
| `legacy-plugin-toast` | Pendiente de clasificación V2 | - |
| `model-fallback` | Pendiente de clasificación V2 | - |
| `monitor-status-injector` | Pendiente de clasificación V2 | - |
| `native-edition-nudge` | Pendiente de clasificación V2 | - |
| `no-hephaestus-non-gpt` | Pendiente de clasificación V2 | - |
| `no-sisyphus-gpt` | Pendiente de clasificación V2 | - |
| `non-interactive-env` | Migrado | El guard nativo V2 antepone el entorno no interactivo a Git en `tool.execute.before` con prefijos por tipo de shell (unix/csh/powershell/cmd, detección de Windows igual que V1 #3607). Un comando interactivo baneado produce la misma advertencia observable de V1 en el output del shell en vez de colgar la sesión (V2 no permite adjuntar un mensaje en `execute.before`). Un servidor V2 aislado probó la reescritura de `git` y la advertencia del comando baneado. `rigel-v2-native-noninteractive.mjs`; `rigel-v2-native-noninteractive.test.mjs`; `qa-v2-noninteractive-contract.mjs` |
| `notepad-write-guard` | Pendiente de clasificación V2 | - |
| `plan-format-validator` | Pendiente de clasificación V2 | - |
| `prometheus-md-only` | Pendiente de clasificación V2 | - |
| `question-label-truncator` | Pendiente de clasificación V2 | - |
| `ralph-loop` | unwired upstream | No se cablea en la composición del runtime V1 upstream (no aparece en `createHooks`). No se cuenta entre los hooks cableados. |
| `read-image-resizer` | Pendiente de clasificación V2 | - |
| `rules-injector` | Migrado parcialmente | El reemplazo nativo V2 descubre reglas de proyecto/globales, aplica `alwaysApply` y globs, deduplica por sesión y anexa la regla al resultado de read/edit/write. El contrato aislado demuestra reglas reales del fork tras `read`; faltan la semántica YAML/picomatch completa y el truncador dinámico V1. `rigel-v2-native-rules.mjs`; `rigel-v2-native-rules.test.mjs`; `qa-v2-native-rules-injector-contract.mjs` |
| `runtime-fallback` | Pendiente de clasificación V2 | - |
| `sisyphus-junior-notepad` | Pendiente de clasificación V2 | - |
| `stop-continuation-guard` | Pendiente de clasificación V2 | - |
| `task-reminder` | unwired upstream | No se cablea en la composición del runtime V1 upstream (no aparece en `createHooks`). No se cuenta entre los hooks cableados. Capacidad V2 relacionada (clasificación retenida en el generador): El reemplazo nativo cuenta diez herramientas no-task por sesión y anexa el recordatorio al resultado de la décima. V2 usa `rigel_task` en vez de la familia V1 `task_*`, por lo que el texto y el mecanismo de seguimiento se adaptan a la superficie disponible. La frontera mutable V2 y la lógica de conteo están probadas. `rigel-v2-native-reminders.mjs`; `rigel-v2-native-reminders.test.mjs`; `qa-v2-tool-after-result-contract.mjs` |
| `task-resume-info` | Migrado | `rigel_task` devuelve `sessionID` en contenido y metadatos, acepta `task_id` y reutiliza el hijo V2 existente. Servidor V2 aislado comprobado en una segunda vuelta del padre. `rigel-v2-native-core.mjs`; `qa-v2-native-delegation.mjs` |
| `tasks-todowrite-disabler` | Pendiente de clasificación V2 | - |
| `team-mailbox-injector` | Pendiente de clasificación V2 | - |
| `team-mode-status-injector` | Pendiente de clasificación V2 | - |
| `team-tool-gating` | Pendiente de clasificación V2 | - |
| `think-mode` | Incompatible (con evidencia) | V1 requiere mutar `chat.message.output.message.variant` por turno. En V2.0.22 la variante se selecciona antes de la frontera `http.request`; la mutación se rechaza y el proveedor no recibe cambio de variante. Las variantes fijas por agente no preservan semántica por mensaje. `qa-v2-chat-message-variant-contract.mjs` |
| `todo-continuation-enforcer` | Incompatible (con evidencia) | La superficie V2 real no publica `session.todo` ni `todowrite`, que son requisitos de la condición de continuidad V1. `qa-v2-compaction-hook-contract.mjs` |
| `todo-description-override` | Pendiente de clasificación V2 | - |
| `tool-pair-validator` | Pendiente de clasificación V2 | - |
| `ulw-execute` | Pendiente de clasificación V2 | - |
| `unstable-agent-babysitter` | Pendiente de clasificación V2 | - |
| `webfetch-redirect-guard` | Pendiente de clasificación V2 | - |
| `write-existing-file-guard` | Migrado parcialmente | El guard nativo V2 bloquea escribir un archivo existente sin lectura previa del mismo sessionID, consume la autorización una vez y conserva bypass `overwrite`/`.omo`. Un contrato V2 aislado confirma que `tool.execute.before` puede cancelar la ejecución real; falta una prueba completa contra el `write` builtin de V2. `rigel-v2-native-write-guard.mjs`; `rigel-v2-native-write-guard.test.mjs`; `qa-v2-tool-before-contract.mjs` |

## Herramientas V1 (14)

| Herramienta V1 | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `background-task` | Migrado parcialmente | Spawn y resultado en background verificados en laboratorio V2; faltan límites, cancelación y persistencia de V1. `rigel-v2-native-core.mjs`; `qa-v2-native-delegation.mjs` |
| `call-omo-agent` | Pendiente de clasificación V2 | - |
| `delegate-task` | Pendiente de clasificación V2 | - |
| `glob` | Pendiente de clasificación V2 | - |
| `grep` | Pendiente de clasificación V2 | - |
| `hashline-edit` | Pendiente de clasificación V2 | - |
| `interactive-bash` | Pendiente de clasificación V2 | - |
| `look-at` | Pendiente de clasificación V2 | - |
| `monitor` | Pendiente de clasificación V2 | - |
| `session-manager` | Pendiente de clasificación V2 | - |
| `skill` | Pendiente de clasificación V2 | - |
| `skill-mcp` | Pendiente de clasificación V2 | - |
| `slashcommand` | Pendiente de clasificación V2 | - |
| `task` | Pendiente de clasificación V2 | - |

## Superficies `features/` (24)

| Superficie | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `background-agent` | Pendiente de clasificación V2 | - |
| `boulder-state` | Pendiente de clasificación V2 | - |
| `btw-side` | Pendiente de clasificación V2 | - |
| `builtin-commands` | Pendiente de clasificación V2 | - |
| `claude-code-agent-loader` | Pendiente de clasificación V2 | - |
| `claude-code-command-loader` | Pendiente de clasificación V2 | - |
| `claude-code-mcp-loader` | Pendiente de clasificación V2 | - |
| `claude-code-session-state` | Pendiente de clasificación V2 | - |
| `claude-tasks` | Pendiente de clasificación V2 | - |
| `context-injector` | Pendiente de clasificación V2 | - |
| `hook-message-injector` | Pendiente de clasificación V2 | - |
| `mcp-oauth` | Pendiente de clasificación V2 | - |
| `monitor` | Pendiente de clasificación V2 | - |
| `native-edition-nudge` | Pendiente de clasificación V2 | - |
| `opencode-runtime-skills` | Pendiente de clasificación V2 | - |
| `opencode-skill-loader` | Pendiente de clasificación V2 | - |
| `opengateway-provider` | Pendiente de clasificación V2 | - |
| `run-continuation-state` | Pendiente de clasificación V2 | - |
| `skill-mcp-manager` | Pendiente de clasificación V2 | - |
| `task-toast-manager` | Pendiente de clasificación V2 | - |
| `team-mode` | Pendiente de clasificación V2 | - |
| `tmux-subagent` | Pendiente de clasificación V2 | - |
| `tool-metadata-store` | Pendiente de clasificación V2 | - |
| `tui-sidebar` | Pendiente de clasificación V2 | - |

## Superficies `plugin/` (39)

| Superficie | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `available-categories` | Pendiente de clasificación V2 | - |
| `build-team-idle-wake-hint-client` | Pendiente de clasificación V2 | - |
| `chat-headers` | Pendiente de clasificación V2 | - |
| `chat-message` | Pendiente de clasificación V2 | - |
| `chat-params` | Pendiente de clasificación V2 | - |
| `command-execute-before` | Pendiente de clasificación V2 | - |
| `event` | Pendiente de clasificación V2 | - |
| `event-error-utils` | Pendiente de clasificación V2 | - |
| `event-hook-dispatcher` | Pendiente de clasificación V2 | - |
| `event-model-fallback` | Pendiente de clasificación V2 | - |
| `event-model-fallback-state` | Pendiente de clasificación V2 | - |
| `event-session-lifecycle` | Pendiente de clasificación V2 | - |
| `event-team-handlers` | Pendiente de clasificación V2 | - |
| `event-types` | Pendiente de clasificación V2 | - |
| `hooks` | Pendiente de clasificación V2 | - |
| `messages-transform` | Pendiente de clasificación V2 | - |
| `native-skills` | Pendiente de clasificación V2 | - |
| `normalize-tool-arg-schemas` | Pendiente de clasificación V2 | - |
| `recent-synthetic-idles` | Pendiente de clasificación V2 | - |
| `runtime-skill-resolver` | Pendiente de clasificación V2 | - |
| `session-agent-resolver` | Pendiente de clasificación V2 | - |
| `session-compacting` | Pendiente de clasificación V2 | - |
| `session-status-normalizer` | Pendiente de clasificación V2 | - |
| `skill-context` | Pendiente de clasificación V2 | - |
| `stop-continuation` | Pendiente de clasificación V2 | - |
| `system-transform` | Pendiente de clasificación V2 | - |
| `tool-definition` | Pendiente de clasificación V2 | - |
| `tool-execute-after` | Pendiente de clasificación V2 | - |
| `tool-execute-before` | Pendiente de clasificación V2 | - |
| `tool-registry` | Pendiente de clasificación V2 | - |
| `tool-registry-core-tools` | Pendiente de clasificación V2 | - |
| `tool-registry-factories` | Pendiente de clasificación V2 | - |
| `tool-registry-gated-tools` | Pendiente de clasificación V2 | - |
| `tool-registry-team-tools` | Pendiente de clasificación V2 | - |
| `tool-registry-trimming` | Pendiente de clasificación V2 | - |
| `ultrawork-db-model-override` | Pendiente de clasificación V2 | - |
| `ultrawork-model-override` | Pendiente de clasificación V2 | - |
| `ultrawork-variant-availability` | Pendiente de clasificación V2 | - |
| `unstable-agent-babysitter` | Pendiente de clasificación V2 | - |

## Superficies `agents/` (37)

| Superficie | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `agent-builder` | Pendiente de clasificación V2 | - |
| `agent-skill-resolution` | Pendiente de clasificación V2 | - |
| `atlas` | Pendiente de clasificación V2 | - |
| `builtin-agents` | Pendiente de clasificación V2 | - |
| `dynamic-agent-category-skills-guide` | Pendiente de clasificación V2 | - |
| `dynamic-agent-core-sections` | Pendiente de clasificación V2 | - |
| `dynamic-agent-policy-sections` | Pendiente de clasificación V2 | - |
| `dynamic-agent-prompt-builder` | Pendiente de clasificación V2 | - |
| `dynamic-agent-prompt-types` | Pendiente de clasificación V2 | - |
| `dynamic-agent-tool-categorization` | Pendiente de clasificación V2 | - |
| `env-context` | Pendiente de clasificación V2 | - |
| `explore` | Pendiente de clasificación V2 | - |
| `frontier-tool-schema-guard` | Pendiente de clasificación V2 | - |
| `gpt-apply-patch-guard` | Pendiente de clasificación V2 | - |
| `gpt-prompt-identity` | Pendiente de clasificación V2 | - |
| `hephaestus` | Pendiente de clasificación V2 | - |
| `kimi-tool-loop-guard` | Pendiente de clasificación V2 | - |
| `librarian` | Pendiente de clasificación V2 | - |
| `metis` | Pendiente de clasificación V2 | - |
| `momus` | Pendiente de clasificación V2 | - |
| `momus-gpt-5-6` | Pendiente de clasificación V2 | - |
| `multimodal-looker` | Pendiente de clasificación V2 | - |
| `oracle` | Pendiente de clasificación V2 | - |
| `prometheus` | Pendiente de clasificación V2 | - |
| `sisyphus` | Pendiente de clasificación V2 | - |
| `sisyphus-agent-config` | Pendiente de clasificación V2 | - |
| `sisyphus-agent-factory` | Pendiente de clasificación V2 | - |
| `sisyphus-dynamic-prompt` | Pendiente de clasificación V2 | - |
| `sisyphus-dynamic-prompt-builder` | Pendiente de clasificación V2 | - |
| `sisyphus-dynamic-prompt-execution` | Pendiente de clasificación V2 | - |
| `sisyphus-dynamic-prompt-exploration` | Pendiente de clasificación V2 | - |
| `sisyphus-dynamic-prompt-role` | Pendiente de clasificación V2 | - |
| `sisyphus-dynamic-prompt-sections` | Pendiente de clasificación V2 | - |
| `sisyphus-dynamic-prompt-style` | Pendiente de clasificación V2 | - |
| `sisyphus-gemini-fallback-overrides` | Pendiente de clasificación V2 | - |
| `sisyphus-junior` | Pendiente de clasificación V2 | - |
| `sisyphus-runtime-prompt-reconciler` | Pendiente de clasificación V2 | - |

## Superficies `mcp/` (7)

| Superficie | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `cli-suffix` | Pendiente de clasificación V2 | - |
| `context7` | Pendiente de clasificación V2 | - |
| `grep-app` | Pendiente de clasificación V2 | - |
| `lsp` | Pendiente de clasificación V2 | - |
| `runtime-executable` | Pendiente de clasificación V2 | - |
| `shared` | Pendiente de clasificación V2 | - |
| `websearch` | Pendiente de clasificación V2 | - |

## Superficies `config/` (3)

| Superficie | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `prune-plugin-view` | Pendiente de clasificación V2 | - |
| `schema` | Pendiente de clasificación V2 | - |
| `validate` | Pendiente de clasificación V2 | - |

## Superficies `cli/` (35)

| Superficie | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `boulder` | Pendiente de clasificación V2 | - |
| `cleanup` | Pendiente de clasificación V2 | - |
| `cleanup-command` | Pendiente de clasificación V2 | - |
| `cli-installer` | Pendiente de clasificación V2 | - |
| `cli-program` | Pendiente de clasificación V2 | - |
| `codex-ulw-loop` | Pendiente de clasificación V2 | - |
| `config-manager` | Pendiente de clasificación V2 | - |
| `config-migrate` | Pendiente de clasificación V2 | - |
| `doctor` | Pendiente de clasificación V2 | - |
| `fallback-chain-resolution` | Pendiente de clasificación V2 | - |
| `fallback-lane-policy` | Pendiente de clasificación V2 | - |
| `get-local-version` | Pendiente de clasificación V2 | - |
| `install` | Pendiente de clasificación V2 | - |
| `install-ast-grep-sg` | Pendiente de clasificación V2 | - |
| `install-codex` | Pendiente de clasificación V2 | - |
| `install-native` | Pendiente de clasificación V2 | - |
| `install-native-dev` | Pendiente de clasificación V2 | - |
| `install-validators` | Pendiente de clasificación V2 | - |
| `mcp-oauth` | Pendiente de clasificación V2 | - |
| `minimum-opencode-version` | Pendiente de clasificación V2 | - |
| `model-fallback` | Pendiente de clasificación V2 | - |
| `model-fallback-requirements` | Pendiente de clasificación V2 | - |
| `model-fallback-types` | Pendiente de clasificación V2 | - |
| `native-dev-platform-flag` | Pendiente de clasificación V2 | - |
| `native-edition-hint` | Pendiente de clasificación V2 | - |
| `openai-only-model-catalog` | Pendiente de clasificación V2 | - |
| `provider-availability` | Pendiente de clasificación V2 | - |
| `provider-model-id-transform` | Pendiente de clasificación V2 | - |
| `refresh-model-capabilities` | Pendiente de clasificación V2 | - |
| `run` | Pendiente de clasificación V2 | - |
| `runtime-commands` | Pendiente de clasificación V2 | - |
| `star-request` | Pendiente de clasificación V2 | - |
| `tui-install-prompts` | Pendiente de clasificación V2 | - |
| `tui-installer` | Pendiente de clasificación V2 | - |
| `worktree-sweep` | Pendiente de clasificación V2 | - |

## Modos y flujos transversales

| Modo / flujo | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `default Ultrawork` | Migrado parcialmente | Inyección raíz predeterminada probada; falta restauración tras compactación. `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs` |
| `keyword Ultrawork / ULW` | Migrado parcialmente | Alias `Ultraworker`/`ultrawork`/`ulw` llegan al proveedor V2 y no a hijos. `qa-v2-native-delegation.mjs` |
| `Hyperplan` | Pendiente de clasificación V2 | - |
| `Team mode` | Pendiente de clasificación V2 | - |
| `Goal` | Pendiente de clasificación V2 | - |
| `continuations` | Pendiente de clasificación V2 | - |
| `background-task handoff` | Migrado parcialmente | Evento `session.execution.*` despierta al padre con resultado visible; faltan reintentos y handoff diferido V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs` |

## Criterio de cierre

Solo puede declararse la migración terminada cuando no existan filas sin clasificación, todas las filas estén marcadas como `Migrado` o `Incompatible (con evidencia)`, y las pruebas V2 correspondientes pasen en el laboratorio aislado.
