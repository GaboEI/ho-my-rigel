#!/usr/bin/env node
/**
 * CLI for the ho-my-rigel -> oh-my-rigel legacy state migration.
 *
 *   node profiles/gabo/migrate-legacy-state.mjs            migrate
 *   node profiles/gabo/migrate-legacy-state.mjs --dry-run   report without writing
 *   node profiles/gabo/migrate-legacy-state.mjs --restore   non-destructive rollback
 *   node profiles/gabo/migrate-legacy-state.mjs --restore --allow-replace
 *                                                           replace conflicts, with backups
 *
 * The command is safe to run repeatedly. It never deletes the legacy source,
 * so `--restore` is a genuine rollback path. By default `--restore` refuses to
 * overwrite a preserved legacy file and reports it as a conflict; the explicit
 * `--allow-replace` opt-in writes a verified `.pre-restore.bak` first.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { migrateLegacyState, restoreLegacyState } from "./legacy-state-migration.mjs"

const args = new Set(process.argv.slice(2))
const home = process.env.HOME || os.homedir()
const xdgDataHome = process.env.XDG_DATA_HOME
const base = xdgDataHome || path.join(home, ".local", "share")
const legacyDir = path.join(base, "ho-my-rigel")
const canonicalDir = path.join(base, "oh-my-rigel")

if (args.has("--dry-run")) {
  const legacyExists = fs.existsSync(legacyDir)
  const canonicalExists = fs.existsSync(canonicalDir)
  console.log(JSON.stringify({
    mode: "dry-run",
    legacyDir,
    canonicalDir,
    legacyExists,
    canonicalExists,
    action: legacyExists ? (canonicalExists ? "merge-non-destructive" : "create-canonical-from-legacy") : "nothing-to-migrate",
  }, null, 2))
  process.exit(0)
}

const result = args.has("--restore")
  ? restoreLegacyState({ home, xdgDataHome, allowReplace: args.has("--allow-replace") })
  : migrateLegacyState({ home, xdgDataHome })
console.log(JSON.stringify(result, null, 2))
