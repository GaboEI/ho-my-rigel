# Rigel — inventario de migración V1 → V2

> Estado: **no completado**. Este documento se genera desde las superficies reales de OmO V1. Ninguna fila marcada como pendiente puede presentarse como migrada.

## Regla de aceptación

Cada capacidad necesita: equivalente V2 identificado, prueba aislada contra OpenCode V2 real y evidencia de que no toca V1. Si V2 carece de API, la fila debe contener la incompatibilidad y la evidencia, no una simulación.

## Resumen de superficies conocidas

| Superficie | Estado | Alcance actual | Evidencia |
| --- | --- | --- | --- |
| Agentes seleccionados | Migrado parcialmente | `agent.transform` + `agent.reload`; falta auditar todos los modos y permisos | `qa-v2-agent-transform-contract.mjs` |
| Delegación nombrada | Migrado parcialmente | `rigel_task`; foreground, continuación y handoff básico en background probados; faltan paridad de categorías y la capa V1 de cola/reintento/deduplicación | `qa-v2-native-delegation.mjs` |
| chat.message | Migrado parcialmente | Adaptación de la superficie V1; no implica los hooks dependientes | `qa-v2-chat-message-contract.mjs` |
| Instrucciones por directorio | Migrado parcialmente | La sustitución nativa conserva los `AGENTS.md` aplicables tras una lectura V2; falta auditar el inyector README y la variante Hephaestus | `rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs` |
| Keyword detector | Migrado parcialmente | Activación explícita `Ultraworker`/`ultrawork`/`ulw` y modo predeterminado, aislados de hijos, probados en V2; faltan team mode, Hyperplan, configuración de exclusión y recuperación tras compactación | `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs` |

## Hooks V1 (54)

| Hook V1 | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `agent-usage-reminder` | Pendiente de clasificación V2 | — |
| `anthropic-context-window-limit-recovery` | Pendiente de clasificación V2 | — |
| `ast-grep-sg-provision` | Pendiente de clasificación V2 | — |
| `atlas` | Pendiente de clasificación V2 | — |
| `auto-slash-command` | Pendiente de clasificación V2 | — |
| `auto-update-checker` | Pendiente de clasificación V2 | — |
| `background-notification` | Migrado parcialmente | Suscripción V2 a eventos terminales y reanudación del padre; faltan cola, reintento y deduplicación del manager V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs` |
| `category-skill-reminder` | Pendiente de clasificación V2 | — |
| `claude-code-hooks` | Pendiente de clasificación V2 | — |
| `comment-checker` | Pendiente de clasificación V2 | — |
| `compaction-context-injector` | Pendiente de clasificación V2 | — |
| `compaction-todo-preserver` | Pendiente de clasificación V2 | — |
| `delegate-task-retry` | Pendiente de clasificación V2 | — |
| `directory-agents-injector` | Migrado parcialmente | Hook V2 `tool.execute.after` recuerda los `AGENTS.md` aplicables a una lectura y los inyecta en la siguiente petición del mismo sessionID. Servidor V2 aislado comprobado; falta auditar README y Hephaestus. `rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs` |
| `directory-readme-injector` | Pendiente de clasificación V2 | — |
| `edit-error-recovery` | Pendiente de clasificación V2 | — |
| `fsync-skip-warning` | Pendiente de clasificación V2 | — |
| `goal` | Pendiente de clasificación V2 | — |
| `hashline-read-enhancer` | Pendiente de clasificación V2 | — |
| `hephaestus-agents-md-injector` | Pendiente de clasificación V2 | — |
| `interactive-bash-session` | Pendiente de clasificación V2 | — |
| `json-error-recovery` | Pendiente de clasificación V2 | — |
| `keyword-detector` | Migrado parcialmente | Activación explícita `Ultraworker`/`ultrawork`/`ulw` y modo predeterminado, aislados de hijos, probados en V2; faltan team mode, Hyperplan, configuración de exclusión y recuperación tras compactación. `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs` |
| `legacy-plugin-toast` | Pendiente de clasificación V2 | — |
| `model-fallback` | Pendiente de clasificación V2 | — |
| `monitor-status-injector` | Pendiente de clasificación V2 | — |
| `native-edition-nudge` | Pendiente de clasificación V2 | — |
| `no-hephaestus-non-gpt` | Pendiente de clasificación V2 | — |
| `no-sisyphus-gpt` | Pendiente de clasificación V2 | — |
| `non-interactive-env` | Pendiente de clasificación V2 | — |
| `notepad-write-guard` | Pendiente de clasificación V2 | — |
| `plan-format-validator` | Pendiente de clasificación V2 | — |
| `prometheus-md-only` | Pendiente de clasificación V2 | — |
| `question-label-truncator` | Pendiente de clasificación V2 | — |
| `ralph-loop` | Pendiente de clasificación V2 | — |
| `read-image-resizer` | Pendiente de clasificación V2 | — |
| `rules-injector` | Pendiente de clasificación V2 | — |
| `runtime-fallback` | Pendiente de clasificación V2 | — |
| `sisyphus-junior-notepad` | Pendiente de clasificación V2 | — |
| `stop-continuation-guard` | Pendiente de clasificación V2 | — |
| `task-reminder` | Pendiente de clasificación V2 | — |
| `task-resume-info` | Pendiente de clasificación V2 | — |
| `tasks-todowrite-disabler` | Pendiente de clasificación V2 | — |
| `team-mailbox-injector` | Pendiente de clasificación V2 | — |
| `team-mode-status-injector` | Pendiente de clasificación V2 | — |
| `team-tool-gating` | Pendiente de clasificación V2 | — |
| `think-mode` | Pendiente de clasificación V2 | — |
| `todo-continuation-enforcer` | Pendiente de clasificación V2 | — |
| `todo-description-override` | Pendiente de clasificación V2 | — |
| `tool-pair-validator` | Pendiente de clasificación V2 | — |
| `ulw-execute` | Pendiente de clasificación V2 | — |
| `unstable-agent-babysitter` | Pendiente de clasificación V2 | — |
| `webfetch-redirect-guard` | Pendiente de clasificación V2 | — |
| `write-existing-file-guard` | Pendiente de clasificación V2 | — |

## Herramientas V1 (14)

| Herramienta V1 | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `background-task` | Migrado parcialmente | Spawn y resultado en background verificados en laboratorio V2; faltan límites, cancelación y persistencia de V1. `rigel-v2-native-core.mjs`; `qa-v2-native-delegation.mjs` |
| `call-omo-agent` | Pendiente de clasificación V2 | — |
| `delegate-task` | Pendiente de clasificación V2 | — |
| `glob` | Pendiente de clasificación V2 | — |
| `grep` | Pendiente de clasificación V2 | — |
| `hashline-edit` | Pendiente de clasificación V2 | — |
| `interactive-bash` | Pendiente de clasificación V2 | — |
| `look-at` | Pendiente de clasificación V2 | — |
| `monitor` | Pendiente de clasificación V2 | — |
| `session-manager` | Pendiente de clasificación V2 | — |
| `skill` | Pendiente de clasificación V2 | — |
| `skill-mcp` | Pendiente de clasificación V2 | — |
| `slashcommand` | Pendiente de clasificación V2 | — |
| `task` | Pendiente de clasificación V2 | — |

## Modos y flujos transversales

| Modo / flujo | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `default Ultrawork` | Migrado parcialmente | Inyección raíz predeterminada probada; falta restauración tras compactación. `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs` |
| `keyword Ultrawork / ULW` | Migrado parcialmente | Alias `Ultraworker`/`ultrawork`/`ulw` llegan al proveedor V2 y no a hijos. `qa-v2-native-delegation.mjs` |
| `Hyperplan` | Pendiente de clasificación V2 | — |
| `Team mode` | Pendiente de clasificación V2 | — |
| `Goal` | Pendiente de clasificación V2 | — |
| `continuations` | Pendiente de clasificación V2 | — |
| `background-task handoff` | Migrado parcialmente | Evento `session.execution.*` despierta al padre con resultado visible; faltan reintentos y handoff diferido V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs` |

## Criterio de cierre

Solo puede declararse la migración terminada cuando no existan filas sin clasificación, todas las filas estén marcadas como `Migrado` o `Incompatible (con evidencia)`, y las pruebas V2 correspondientes pasen en el laboratorio aislado.
