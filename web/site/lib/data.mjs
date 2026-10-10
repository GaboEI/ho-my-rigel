import { readFile } from "node:fs/promises"

import { SITE } from "./config.mjs"

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, SITE.sourceDir), "utf8"))
}

export async function loadSource() {
  const [catalog, agents, chains, cli, guide, seal] = await Promise.all([
    readJson("catalog.json"),
    readJson("agents.json"),
    readJson("chains.json"),
    readJson("cli.json"),
    readJson("guide.json"),
    readJson("seal.json"),
  ])
  return { catalog, agents, chains, cli, guide, seal }
}
