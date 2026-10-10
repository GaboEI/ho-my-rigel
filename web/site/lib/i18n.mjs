import { readFile } from "node:fs/promises"

import { SITE } from "./config.mjs"

// W3 §4.2 overlay mechanism: `web/data/i18n/<document>.<locale>.json` is an id-anchored
// layer over the W2 source. Only translatable, id-keyed fields are replaced; structural
// fields and ids stay exactly as the W2 source declares them. The overlay files are part
// of the W2 seal (seal-lib SEALED_FILES), so an unsealed edit fails the W2 suite.
const OVERLAYS = { catalog: "catalog.en.json", guide: "guide.en.json" }

async function readOverlay(name) {
  try {
    return JSON.parse(await readFile(new URL(`i18n/${name}`, SITE.sourceDir), "utf8"))
  } catch {
    return null
  }
}

export async function loadOverlays() {
  const overlays = {}
  for (const [document, file] of Object.entries(OVERLAYS)) overlays[document] = await readOverlay(file)
  return overlays
}

function overlayText(overlay, group, id, field, fallback) {
  const value = overlay?.[group]?.[id]?.[field]
  return typeof value === "string" && value.length > 0 ? value : fallback
}

// Replaces only the translatable prose of guide.json with the EN overlay; ids, provenance,
// surface and command names stay exactly as the source declares them.
function localizeGuide(guide, overlay) {
  if (!overlay) return guide
  const agents = guide.agents.map((agent) => ({
    ...agent,
    funcion: overlayText(overlay, "agents", agent.id, "funcion", agent.funcion),
    cuandoUsar: overlayText(overlay, "agents", agent.id, "cuandoUsar", agent.cuandoUsar),
  }))
  const skills = guide.skills.map((skill) => ({
    ...skill,
    funcion: overlayText(overlay, "skills", skill.id, "funcion", skill.funcion),
    uso: overlayText(overlay, "skills", skill.id, "uso", skill.uso),
  }))
  const commands = guide.commands.map((command) => ({
    ...command,
    queHace: overlayText(overlay, "commands", command.id, "queHace", command.queHace),
    queToca: overlayText(overlay, "commands", command.id, "queToca", command.queToca),
  }))
  return { ...guide, agents, skills, commands }
}

function localizeCatalog(catalog, overlay) {
  if (!overlay) return catalog
  const areas = catalog.areas.map((area) => {
    const name = overlay.areas?.[area.id]?.name
    return name ? { ...area, name } : area
  })
  const functions = catalog.functions.map((fn) => {
    const o = overlay.functions?.[fn.id]
    if (!o) return fn
    const translate = (field, value) => (field?.procedencia === "derivado" ? { ...field, valor: value } : { ...field, razon: value })
    return {
      ...fn,
      nombre: o.nombre,
      que_es: o.que_es,
      modo_de_activacion: o.modo_de_activacion,
      como_se_usa: o.como_se_usa,
      cuando_sirve: o.cuando_sirve,
      requisitos: translate(fn.requisitos, o.requisitos),
      valores_por_defecto: translate(fn.valores_por_defecto, o.valores_por_defecto),
    }
  })
  return { ...catalog, areas, functions }
}

export function localizeSource(source, lang, overlays) {
  if (lang !== "en") return source
  return {
    ...source,
    catalog: localizeCatalog(source.catalog, overlays.catalog),
    guide: localizeGuide(source.guide, overlays.guide),
  }
}
