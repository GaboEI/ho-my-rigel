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

function markdownRows(items) {
  return items.map((item) => `| \`${item}\` | Pendiente de clasificación V2 | — |`).join("\n")
}

const hooks = directoriesWithIndex(hooksRoot)
const tools = directoriesWithIndex(toolsRoot)
const modes = ["default Ultrawork", "keyword Ultrawork / ULW", "Hyperplan", "Team mode", "Goal", "continuations", "background-task handoff"]
const known = [
  ["Agentes seleccionados", "Migrado parcialmente", "`agent.transform` + `agent.reload`; falta auditar todos los modos y permisos", "`qa-v2-agent-transform-contract.mjs`"],
  ["Delegación nombrada", "Migrado parcialmente", "`rigel_task`; foreground probado; faltan continuaciones, categorías y background handoff", "`qa-v2-native-delegation.mjs`"],
  ["chat.message", "Migrado parcialmente", "Adaptación de la superficie V1; no implica los hooks dependientes", "`qa-v2-chat-message-contract.mjs`"],
  ["Keyword detector", "En curso", "Ultrawork/ULW no estaba migrado; la primera adaptación nativa está en desarrollo", "pendiente de contrato V2 final"],
]

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
  markdownRows(hooks),
  "",
  `## Herramientas V1 (${tools.length})`,
  "",
  "| Herramienta V1 | Estado | Equivalente / evidencia V2 |",
  "| --- | --- | --- |",
  markdownRows(tools),
  "",
  "## Modos y flujos transversales",
  "",
  "| Modo / flujo | Estado | Equivalente / evidencia V2 |",
  "| --- | --- | --- |",
  markdownRows(modes),
  "",
  "## Criterio de cierre",
  "",
  "Solo puede declararse la migración terminada cuando no existan filas sin clasificación, todas las filas estén marcadas como `Migrado` o `Incompatible (con evidencia)`, y las pruebas V2 correspondientes pasen en el laboratorio aislado.",
  "",
].join("\n")

fs.writeFileSync(output, document, { mode: 0o600 })
process.stdout.write(JSON.stringify({ output, hooks: hooks.length, tools: tools.length, modes: modes.length }) + "\n")
