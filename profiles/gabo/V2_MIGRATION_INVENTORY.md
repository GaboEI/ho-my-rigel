# Rigel — inventario de migración V1 → V2

> Estado: **no completado**. Este documento se genera desde las superficies reales de OmO V1. Ninguna fila marcada como pendiente puede presentarse como migrada.

## Regla de aceptación

Cada capacidad necesita: equivalente V2 identificado, prueba aislada contra OpenCode V2 real y evidencia de que no toca V1. Si V2 carece de API, la fila debe contener la incompatibilidad y la evidencia, no una simulación.

## Resumen de superficies conocidas

| Superficie | Estado | Alcance actual | Evidencia |
| --- | --- | --- | --- |
| Agentes seleccionados | Migrado parcialmente | `agent.transform` + `agent.reload`; falta auditar todos los modos y permisos | `qa-v2-agent-transform-contract.mjs` |
| Delegación nombrada | Migrado parcialmente | `rigel_task`; foreground probado; faltan continuaciones, categorías y background handoff | `qa-v2-native-delegation.mjs` |
| chat.message | Migrado parcialmente | Adaptación de la superficie V1; no implica los hooks dependientes | `qa-v2-chat-message-contract.mjs` |
| Keyword detector | En curso | Ultrawork/ULW no estaba migrado; la primera adaptación nativa está en desarrollo | pendiente de contrato V2 final |

## Hooks V1 (54)

| Hook V1 | Estado | Equivalente / evidencia V2 |
| --- | --- | --- |
| `agent-usage-reminder` | Pendiente de clasificación V2 | — |
| `anthropic-context-window-limit-recovery` | Pendiente de clasificación V2 | — |
| `ast-grep-sg-provision` | Pendiente de clasificación V2 | — |
| `atlas` | Pendiente de clasificación V2 | — |
| `auto-slash-command` | Pendiente de clasificación V2 | — |
| `auto-update-checker` | Pendiente de clasificación V2 | — |
| `background-notification` | Pendiente de clasificación V2 | — |
| `category-skill-reminder` | Pendiente de clasificación V2 | — |
| `claude-code-hooks` | Pendiente de clasificación V2 | — |
| `comment-checker` | Pendiente de clasificación V2 | — |
| `compaction-context-injector` | Pendiente de clasificación V2 | — |
| `compaction-todo-preserver` | Pendiente de clasificación V2 | — |
| `delegate-task-retry` | Pendiente de clasificación V2 | — |
| `directory-agents-injector` | Pendiente de clasificación V2 | — |
| `directory-readme-injector` | Pendiente de clasificación V2 | — |
| `edit-error-recovery` | Pendiente de clasificación V2 | — |
| `fsync-skip-warning` | Pendiente de clasificación V2 | — |
| `goal` | Pendiente de clasificación V2 | — |
| `hashline-read-enhancer` | Pendiente de clasificación V2 | — |
| `hephaestus-agents-md-injector` | Pendiente de clasificación V2 | — |
| `interactive-bash-session` | Pendiente de clasificación V2 | — |
| `json-error-recovery` | Pendiente de clasificación V2 | — |
| `keyword-detector` | Pendiente de clasificación V2 | — |
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
| `background-task` | Pendiente de clasificación V2 | — |
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
| `default Ultrawork` | Pendiente de clasificación V2 | — |
| `keyword Ultrawork / ULW` | Pendiente de clasificación V2 | — |
| `Hyperplan` | Pendiente de clasificación V2 | — |
| `Team mode` | Pendiente de clasificación V2 | — |
| `Goal` | Pendiente de clasificación V2 | — |
| `continuations` | Pendiente de clasificación V2 | — |
| `background-task handoff` | Pendiente de clasificación V2 | — |

## Criterio de cierre

Solo puede declararse la migración terminada cuando no existan filas sin clasificación, todas las filas estén marcadas como `Migrado` o `Incompatible (con evidencia)`, y las pruebas V2 correspondientes pasen en el laboratorio aislado.
