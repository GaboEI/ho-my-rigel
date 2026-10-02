#!/usr/bin/env node
/**
 * Produces the authoritative migration ledger from the V1 source tree.
 * A V2 feature is not considered migrated until it is explicitly mapped here
 * and backed by an isolated V2 contract.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const hooksRoot = path.join(root, "packages/omo-opencode/src/hooks")
const toolsRoot = path.join(root, "packages/omo-opencode/src/tools")
const output = path.join(root, "profiles/gabo/V2_MIGRATION_INVENTORY.md")

function directoriesWithIndex(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("zauc-")) continue
    const nested = path.join(directory, entry.name)
    if (fs.existsSync(path.join(nested, "index.ts"))) result.push(entry.name)
  }
  return result.sort()
}

function markdownRows(items, overrides = {}) {
  return items.map((item) => {
    const override = overrides[item]
    return override
      ? `| \`${item}\` | ${override.status} | ${override.evidence} |`
      : `| \`${item}\` | Pendiente de clasificación V2 | — |`
  }).join("\n")
}

const hooks = directoriesWithIndex(hooksRoot)
const tools = directoriesWithIndex(toolsRoot)
const modes = ["default Ultrawork", "keyword Ultrawork / ULW", "Hyperplan", "Team mode", "Goal", "continuations", "background-task handoff"]
const known = [
  ["Agentes seleccionados", "Migrado parcialmente", "`agent.transform` + `agent.reload`; falta auditar todos los modos y permisos", "`qa-v2-agent-transform-contract.mjs`"],
  ["Delegación nombrada", "Migrado parcialmente", "`rigel_task`; foreground, continuación y handoff básico en background probados; faltan paridad de categorías y la capa V1 de cola/reintento/deduplicación", "`qa-v2-native-delegation.mjs`"],
  ["chat.message", "Migrado parcialmente", "Adaptación de la superficie V1; no implica los hooks dependientes", "`qa-v2-chat-message-contract.mjs`"],
  ["Instrucciones por directorio", "Migrado parcialmente", "La sustitución nativa conserva `AGENTS.md` y `README.md` aplicables tras una lectura V2, y el `AGENTS.md` raíz antes del primer turno de Hephaestus", "`rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs`"],
  ["Continuidad de compactación", "Incompatible parcialmente", "V2 conserva su resumen nativo, pero su hook de compactación no propaga contexto adicional al modelo; no se puede portar el inyector V1 sin sustituir el resumen", "`qa-v2-compaction-hook-contract.mjs`"],
  ["Keyword detector", "Migrado parcialmente", "Activación explícita `Ultraworker`/`ultrawork`/`ulw` y modo predeterminado, aislados de hijos, probados en V2; faltan team mode, Hyperplan, configuración de exclusión y recuperación tras compactación", "`rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs`"],
]

// Overrides are source-controlled instead of hand edits in the generated
// document.  A successful regeneration therefore cannot silently downgrade
// completed or partially-audited work back to "pending".
const hookOverrides = {
  "background-notification": { status: "Migrado parcialmente", evidence: "Suscripción V2 a eventos terminales y reanudación del padre; faltan cola, reintento y deduplicación del manager V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs`" },
  "compaction-context-injector": { status: "Incompatible (con evidencia)", evidence: "V2.0.22 invoca `session.hook(\"compaction\")`, pero las mutaciones de `event.system` no llegan a la petición real del proveedor que genera el resumen. No se usa `result`, pues reemplazaría el resumen nativo. `qa-v2-compaction-hook-contract.mjs`" },
  "compaction-todo-preserver": { status: "Incompatible (con evidencia)", evidence: "La superficie V2 real de `context.session` no expone `todo`, y el catálogo de herramientas del turno V2 no contiene `todowrite`; por tanto no existe lectura ni escritura nativa de todos que permita preservar la lista V1. `qa-v2-compaction-hook-contract.mjs`" },
  "directory-agents-injector": { status: "Migrado parcialmente", evidence: "Hook V2 `tool.execute.after` recuerda los `AGENTS.md` aplicables a una lectura y los inyecta en la siguiente petición del mismo sessionID. Servidor V2 aislado comprobado. `rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs`" },
  "directory-readme-injector": { status: "Migrado parcialmente", evidence: "El mismo hook V2 conserva los `README.md` aplicables a una lectura y los inyecta como contexto en la siguiente petición del mismo sessionID. Servidor V2 aislado comprobado. `rigel-v2-directory-instructions.mjs`; `qa-v2-agents-md-contract.mjs`" },
  "hephaestus-agents-md-injector": { status: "Migrado parcialmente", evidence: "Para cualquier manifiesto V2 que incluya Hephaestus, la petición inicial recibe el `AGENTS.md` raíz; contrato aislado V2 comprobado. El perfil de laboratorio de Gabo lo excluye de forma explícita, por lo que no es una capacidad visible allí. `rigel-v2-native.mjs`; `qa-v2-agents-md-contract.mjs`; `v2-agent-selection.json`" },
  "task-resume-info": { status: "Migrado", evidence: "`rigel_task` devuelve `sessionID` en contenido y metadatos, acepta `task_id` y reutiliza el hijo V2 existente. Servidor V2 aislado comprobado en una segunda vuelta del padre. `rigel-v2-native-core.mjs`; `qa-v2-native-delegation.mjs`" },
  "todo-continuation-enforcer": { status: "Incompatible (con evidencia)", evidence: "La superficie V2 real no publica `session.todo` ni `todowrite`, que son requisitos de la condición de continuidad V1. `qa-v2-compaction-hook-contract.mjs`" },
  "keyword-detector": { status: "Migrado parcialmente", evidence: "Activación explícita `Ultraworker`/`ultrawork`/`ulw` y modo predeterminado, aislados de hijos, probados en V2; faltan team mode, Hyperplan, configuración de exclusión y recuperación tras compactación. `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs`" },
}
const toolOverrides = {
  "background-task": { status: "Migrado parcialmente", evidence: "Spawn y resultado en background verificados en laboratorio V2; faltan límites, cancelación y persistencia de V1. `rigel-v2-native-core.mjs`; `qa-v2-native-delegation.mjs`" },
}
const modeOverrides = {
  "default Ultrawork": { status: "Migrado parcialmente", evidence: "Inyección raíz predeterminada probada; falta restauración tras compactación. `rigel-v2-native-prompt.mjs`; `qa-v2-native-delegation.mjs`" },
  "keyword Ultrawork / ULW": { status: "Migrado parcialmente", evidence: "Alias `Ultraworker`/`ultrawork`/`ulw` llegan al proveedor V2 y no a hijos. `qa-v2-native-delegation.mjs`" },
  "background-task handoff": { status: "Migrado parcialmente", evidence: "Evento `session.execution.*` despierta al padre con resultado visible; faltan reintentos y handoff diferido V1. `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs`" },
}

const document = [
  "# Rigel — inventario de migración V1 → V2",
  "",
  "> Estado: **no completado**. Este documento se genera desde las superficies reales de OmO V1. Ninguna fila marcada como pendiente puede presentarse como migrada.",
  "",
  "## Regla de aceptación",
  "",
  "Cada capacidad necesita: equivalente V2 identificado, prueba aislada contra OpenCode V2 real y evidencia de que no toca V1. Si V2 carece de API, la fila debe contener la incompatibilidad y la evidencia, no una simulación.",
  "",
  "## Resumen de superficies conocidas",
  "",
  "| Superficie | Estado | Alcance actual | Evidencia |",
  "| --- | --- | --- | --- |",
  ...known.map((row) => `| ${row.join(" | ")} |`),
  "",
  `## Hooks V1 (${hooks.length})`,
  "",
  "| Hook V1 | Estado | Equivalente / evidencia V2 |",
  "| --- | --- | --- |",
  markdownRows(hooks, hookOverrides),
  "",
  `## Herramientas V1 (${tools.length})`,
  "",
  "| Herramienta V1 | Estado | Equivalente / evidencia V2 |",
  "| --- | --- | --- |",
  markdownRows(tools, toolOverrides),
  "",
  "## Modos y flujos transversales",
  "",
  "| Modo / flujo | Estado | Equivalente / evidencia V2 |",
  "| --- | --- | --- |",
  markdownRows(modes, modeOverrides),
  "",
  "## Criterio de cierre",
  "",
  "Solo puede declararse la migración terminada cuando no existan filas sin clasificación, todas las filas estén marcadas como `Migrado` o `Incompatible (con evidencia)`, y las pruebas V2 correspondientes pasen en el laboratorio aislado.",
  "",
].join("\n")

fs.writeFileSync(output, document, { mode: 0o600 })
process.stdout.write(JSON.stringify({ output, hooks: hooks.length, tools: tools.length, modes: modes.length }) + "\n")
