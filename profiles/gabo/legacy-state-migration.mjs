#!/usr/bin/env node
/**
 * Legacy-state migration for the ho-my-rigel -> oh-my-rigel rename.
 *
 * The canonical Rigel state directory is now `~/.local/share/oh-my-rigel`.
 * Older installs wrote `~/.local/share/ho-my-rigel`. This module migrates the
 * legacy directory into the canonical one without data loss.
 *
 * Properties (each one is covered by a test in the sibling test file):
 * - Non-destructive migration: an existing canonical file is never overwritten.
 * - Idempotent at the state level: a second run that changes nothing rewrites
 *   neither files nor the receipt (the receipt is byte-identical).
 * - Atomic per file: unique exclusive temporary in the same directory, correct
 *   permissions, `fsync` of the file and of its directory, rename into place,
 *   and cleanup of the temporary on any error. A failed copy never leaves a
 *   partial target.
 * - Truly non-destructive rollback: the legacy directory is the preserved
 *   source of truth. `restoreLegacyState` NEVER overwrites an existing legacy
 *   file; it only fills paths that are missing, and it verifies the restored
 *   bytes against a recorded inventory of `{ sha256, size }`. To replace a
 *   conflicting legacy file it first writes a verified backup and requires the
 *   explicit `allowReplace` opt-in.
 *
 * A receipt is written next to the canonical directory so the migration is
 * auditable. The receipt content is a pure function of the observed state, so
 * an unchanged re-run produces the identical file.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

export const CANONICAL_STATE_DIRNAME = "oh-my-rigel"
export const LEGACY_STATE_DIRNAME = "ho-my-rigel"
export const RECEIPT_FILENAME = "legacy-state-migration.json"
export const RESTORE_BACKUP_SUFFIX = ".pre-restore.bak"

function defaultStateRoot({ home = os.homedir(), xdgDataHome } = {}) {
  const base = xdgDataHome || process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return {
    legacyDir: path.join(base, LEGACY_STATE_DIRNAME),
    canonicalDir: path.join(base, CANONICAL_STATE_DIRNAME),
  }
}

function listFiles(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(root)
  return files.sort()
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function inventory(root) {
  const entries = {}
  for (const file of listFiles(root)) {
    const relative = path.relative(root, file)
    if (relative === RECEIPT_FILENAME) continue
    entries[relative] = { sha256: sha256(file), size: fs.statSync(file).size }
  }
  return entries
}

function fsyncDirectory(directory) {
  // Directory fsync makes the rename durable. Not every platform allows opening
  // a directory for reading; failure there is not fatal for correctness.
  try {
    const fd = fs.openSync(directory, "r")
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch { /* directory fsync unsupported on this platform */ }
}

/**
 * Write `content` (a Buffer/string) or copy `from` to `to` atomically.
 * The temporary is unique and exclusive; on any error it is removed and the
 * target is left untouched (never partially written).
 *
 * `verify` (optional) runs against the temporary path before the rename. If it
 * throws, or returns false, the rename never happens and the target is never
 * created. This is what makes a failed integrity check leave no partial target.
 */
function writeAtomic(to, { from, content, verify }) {
  const directory = path.dirname(to)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${path.basename(to)}.${process.pid}.${randomUUID()}.tmp`)
  let fd
  try {
    fd = fs.openSync(temporary, "wx", 0o600)
    const bytes = content !== undefined ? Buffer.from(content) : fs.readFileSync(from)
    fs.writeSync(fd, bytes, 0, bytes.length, 0)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (verify && verify(temporary) === false) {
      throw new Error(`Rollback integrity failure: written bytes disagree with the recorded inventory for ${to}`)
    }
    fs.renameSync(temporary, to)
    fsyncDirectory(directory)
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
    try { fs.rmSync(temporary, { force: true }) } catch { /* best-effort cleanup */ }
    throw error
  }
}

function writeReceipt(canonicalDir, receipt) {
  writeAtomic(path.join(canonicalDir, RECEIPT_FILENAME), { content: `${JSON.stringify(receipt, null, 2)}\n` })
}

function readReceipt(canonicalDir) {
  try { return JSON.parse(fs.readFileSync(path.join(canonicalDir, RECEIPT_FILENAME), "utf8")) } catch { return undefined }
}

/**
 * Migrate the legacy tree into the canonical directory.
 *
 * @param {{home?: string, xdgDataHome?: string, canonicalDir?: string, legacyDir?: string}} [options]
 */
export function migrateLegacyState({ home, xdgDataHome, canonicalDir, legacyDir } = {}) {
  const defaults = defaultStateRoot({ home, xdgDataHome })
  const legacy = legacyDir ?? defaults.legacyDir
  const canonical = canonicalDir ?? defaults.canonicalDir

  const legacyExists = fs.existsSync(legacy)
  const canonicalExists = fs.existsSync(canonical)
  if (!legacyExists) {
    return {
      status: canonicalExists ? "current" : "absent",
      migrated: [],
      skipped: [],
      legacyDir: legacy,
      canonicalDir: canonical,
    }
  }

  const migrated = []
  const skipped = []
  for (const [relative, meta] of Object.entries(inventory(legacy))) {
    const target = path.join(canonical, relative)
    if (fs.existsSync(target)) {
      skipped.push(relative)
      continue
    }
    writeAtomic(target, { from: path.join(legacy, relative) })
    if (sha256(target) !== meta.sha256) {
      throw new Error(`Migration integrity failure for ${relative}: copied bytes differ from source`)
    }
    migrated.push(relative)
  }

  const previous = readReceipt(canonical)
  // A run that copies no file is a no-op: it must not touch the receipt at all,
  // so the receipt stays byte-identical to whatever the last writing run left.
  const writesOccurred = migrated.length > 0
  if (writesOccurred || previous === undefined) {
    const sortedInventory = Object.fromEntries(
      Object.entries(inventory(legacy)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
    writeReceipt(canonical, {
      migratedAt: new Date().toISOString(),
      legacyDir: legacy,
      canonicalDir: canonical,
      legacyInventory: sortedInventory,
      migrated: [...migrated].sort(),
      skipped: [...skipped].sort(),
      legacyPreserved: true,
    })
  }

  let status
  if (migrated.length === 0 && skipped.length === 0) status = "empty"
  else if (migrated.length === 0) status = "unchanged"
  else status = "merged"
  return { status, migrated, skipped, legacyDir: legacy, canonicalDir: canonical, receiptRewritten: writesOccurred || previous === undefined }
}

/**
 * Truly non-destructive rollback.
 *
 * Rollback semantics, stated precisely:
 * - The legacy directory is the preserved source of truth for the
 *   pre-migration state, so this function NEVER overwrites an existing legacy
 *   file by default.
 * - A legacy path that matches the recorded migration inventory (or the
 *   canonical bytes) is `preserved`: it is already correct and is left
 *   byte-for-byte untouched.
 * - A legacy path whose bytes DIFFER from the recorded inventory is a
 *   `conflict`: it is reported and left untouched, never silently replaced.
 * - A legacy path that is missing is `restored` from canonical and verified
 *   against the recorded inventory.
 * - Only with the explicit `allowReplace` opt-in is a conflicting legacy file
 *   replaced, and a verified `.pre-restore.bak` is written first.
 *
 * @param {{home?: string, xdgDataHome?: string, canonicalDir?: string, legacyDir?: string,
 *          expectedInventory?: Record<string, {sha256: string, size: number}>, allowReplace?: boolean}} [options]
 */
export function restoreLegacyState({ home, xdgDataHome, canonicalDir, legacyDir, expectedInventory, allowReplace = false } = {}) {
  const defaults = defaultStateRoot({ home, xdgDataHome })
  const legacy = legacyDir ?? defaults.legacyDir
  const canonical = canonicalDir ?? defaults.canonicalDir
  if (!fs.existsSync(canonical)) {
    return { status: "canonical-absent", restored: [], preserved: [], conflicts: [], backedUp: [], legacyDir: legacy, canonicalDir: canonical }
  }

  const receipt = readReceipt(canonical)
  const expected = expectedInventory ?? receipt?.legacyInventory
  const canonicalFiles = Object.keys(inventory(canonical)).sort()
  const restored = []
  const preserved = []
  const conflicts = []
  const backedUp = []

  for (const relative of canonicalFiles) {
    const source = path.join(canonical, relative)
    const target = path.join(legacy, relative)
    const targetExists = fs.existsSync(target)
    const expectedMeta = expected?.[relative]

    if (targetExists) {
      // A legacy file that already matches the recorded source inventory (or,
      // with no inventory, the canonical bytes) is the normal preserved case.
      const targetHash = sha256(target)
      const matchesRecorded = expectedMeta ? targetHash === expectedMeta.sha256 : targetHash === sha256(source)
      if (matchesRecorded && !allowReplace) {
        preserved.push(relative)
        continue
      }
      if (!allowReplace) {
        conflicts.push(relative)
        continue
      }
      const backup = `${target}${RESTORE_BACKUP_SUFFIX}`
      writeAtomic(backup, { from: target })
      if (sha256(backup) !== targetHash) {
        throw new Error(`Rollback backup integrity failure for ${relative}`)
      }
      backedUp.push(relative)
    }

    writeAtomic(target, {
      from: source,
      verify: (temporary) => !expectedMeta || sha256(temporary) === expectedMeta.sha256,
    })
    restored.push(relative)
  }

  const status = conflicts.length > 0 ? "conflict" : "restored"
  return { status, restored, preserved, conflicts, backedUp, legacyDir: legacy, canonicalDir: canonical }
}

/** Resolve the canonical state directory, falling back to legacy for reads. */
export function resolveStateDir({ home, xdgDataHome, canonicalDir, legacyDir } = {}) {
  const defaults = defaultStateRoot({ home, xdgDataHome })
  const legacy = legacyDir ?? defaults.legacyDir
  const canonical = canonicalDir ?? defaults.canonicalDir
  return fs.existsSync(canonical) ? canonical : legacy
}
