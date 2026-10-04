#!/usr/bin/env node
/**
 * Contract tests for the ho-my-rigel -> oh-my-rigel legacy state migration.
 * These tests never touch the real HOME: every case uses a temporary tree.
 *
 * Covered contracts (audit-mandated):
 * - migration is non-destructive and idempotent (receipt byte-identical on a
 *   no-op second run);
 * - atomic writes leave no partial target when a copy fails mid-way;
 * - rollback is truly non-destructive: it never silently overwrites preserved
 *   legacy files, reports conflicts, and never mutates the preserved tree;
 * - negative conflict controls with explicit, verified backups on opt-in;
 * - the legacy tree is byte-identical before migrate and after restore.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  migrateLegacyState,
  restoreLegacyState,
  resolveStateDir,
  RECEIPT_FILENAME,
  RESTORE_BACKUP_SUFFIX,
} from "./legacy-state-migration.mjs"

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rigel-state-migration-"))
}
function seed(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}
function digestTree(root) {
  const out = {}
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out[path.relative(root, full)] = createHash("sha256").update(fs.readFileSync(full)).digest("hex")
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

describe("legacy state migration", () => {
  it("copies the legacy tree into the canonical directory without deleting legacy", () => {
    // given
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"a\":1}", "nested/receipt.json": "{\"b\":2}" })

    // when
    const result = migrateLegacyState({ legacyDir: legacy, canonicalDir: canonical })

    // then
    assert.equal(result.status, "merged")
    assert.deepEqual(result.migrated.sort(), ["nested/receipt.json", "skills-v2.json"])
    assert.equal(fs.readFileSync(path.join(canonical, "skills-v2.json"), "utf8"), "{\"a\":1}")
    assert.equal(fs.readFileSync(path.join(canonical, "nested/receipt.json"), "utf8"), "{\"b\":2}")
    assert.ok(fs.existsSync(path.join(legacy, "skills-v2.json")), "legacy source is preserved")
    assert.ok(fs.existsSync(path.join(canonical, RECEIPT_FILENAME)), "receipt is written")
  })

  it("does not overwrite an existing canonical file and keeps it authoritative", () => {
    // given
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"a\":1}" })
    seed(canonical, { "skills-v2.json": "{\"a\":2}" })

    // when
    const result = migrateLegacyState({ legacyDir: legacy, canonicalDir: canonical })

    // then
    assert.deepEqual(result.migrated, [])
    assert.deepEqual(result.skipped, ["skills-v2.json"])
    assert.equal(fs.readFileSync(path.join(canonical, "skills-v2.json"), "utf8"), "{\"a\":2}")
  })

  it("is idempotent at the state level: a no-op second run leaves the receipt byte-identical", () => {
    // given
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"a\":1}", "nested/receipt.json": "{\"b\":2}" })
    migrateLegacyState({ legacyDir: legacy, canonicalDir: canonical })
    const receiptPath = path.join(canonical, RECEIPT_FILENAME)
    const firstReceipt = fs.readFileSync(receiptPath)

    // when
    const second = migrateLegacyState({ legacyDir: legacy, canonicalDir: canonical })

    // then
    assert.equal(second.status, "unchanged")
    assert.equal(second.receiptRewritten, false)
    assert.deepEqual(fs.readFileSync(receiptPath), firstReceipt, "receipt bytes must not change on a no-op re-run")
  })

  it("keeps the legacy tree byte-identical across migrate and a non-destructive restore", () => {
    // given
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"a\":1}", "nested/receipt.json": "{\"b\":2}" })
    const before = digestTree(legacy)

    // when
    migrateLegacyState({ legacyDir: legacy, canonicalDir: canonical })
    const restore = restoreLegacyState({ legacyDir: legacy, canonicalDir: canonical })

    // then: every legacy path matches the recorded inventory, so all are
    // preserved and nothing is written.
    assert.equal(restore.status, "restored")
    assert.deepEqual(restore.restored, [], "nothing is written back; the preserved tree is already exact")
    assert.deepEqual(restore.preserved.sort(), ["nested/receipt.json", "skills-v2.json"])
    assert.deepEqual(digestTree(legacy), before, "legacy bytes are unchanged after migrate + restore")
  })

  it("reports conflicts instead of overwriting a preserved legacy file, and does not mutate it", () => {
    // given: legacy file differs from the recorded inventory (a divergent
    // pre-migration edit made after migration recorded its hashes)
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"legacy\":true}" })
    seed(canonical, { "skills-v2.json": "{\"canonical\":true}" })
    const before = digestTree(legacy)

    // when
    const restore = restoreLegacyState({ legacyDir: legacy, canonicalDir: canonical })

    // then: the conflict is surfaced, the legacy file is untouched
    assert.equal(restore.status, "conflict")
    assert.deepEqual(restore.conflicts, ["skills-v2.json"])
    assert.deepEqual(restore.restored, [])
    assert.deepEqual(digestTree(legacy), before, "a preserved legacy file is never silently overwritten")
  })

  it("only replaces a conflicting legacy file under explicit opt-in, with a verified backup", () => {
    // given
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"legacy\":true}" })
    seed(canonical, { "skills-v2.json": "{\"canonical\":true}" })

    // when
    const restore = restoreLegacyState({ legacyDir: legacy, canonicalDir: canonical, allowReplace: true })

    // then
    assert.equal(restore.status, "restored")
    assert.deepEqual(restore.backedUp, ["skills-v2.json"])
    assert.equal(fs.readFileSync(path.join(legacy, "skills-v2.json"), "utf8"), "{\"canonical\":true}")
    assert.equal(
      fs.readFileSync(path.join(legacy, `skills-v2.json${RESTORE_BACKUP_SUFFIX}`), "utf8"),
      "{\"legacy\":true}",
      "the pre-restore bytes are recoverable from the backup",
    )
  })

  it("verifies restored bytes against the recorded inventory and rejects a mismatch", () => {
    // given: the legacy target is missing, so restore must write it and verify
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"a\":1}" })
    migrateLegacyState({ legacyDir: legacy, canonicalDir: canonical })
    fs.rmSync(path.join(legacy, "skills-v2.json"))

    // when / then: a wrong expected hash fails and restores nothing
    assert.throws(
      () => restoreLegacyState({
        legacyDir: legacy,
        canonicalDir: canonical,
        expectedInventory: { "skills-v2.json": { sha256: "deadbeef", size: 1 } },
      }),
      /Rollback integrity failure/,
    )
    assert.equal(fs.existsSync(path.join(legacy, "skills-v2.json")), false, "the failed restore wrote nothing")
  })

  it("leaves no partial target when a write fails mid-way", () => {
    // given: a canonical directory that cannot be written (read-only parent)
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    seed(legacy, { "skills-v2.json": "{\"a\":1}" })
    fs.mkdirSync(canonical, { recursive: true })
    fs.chmodSync(canonical, 0o500)

    // when / then
    try {
      assert.throws(() => migrateLegacyState({ legacyDir: legacy, canonicalDir: canonical }))
    } finally {
      fs.chmodSync(canonical, 0o700)
    }
    const leftovers = fs.readdirSync(canonical).filter((name) => name.includes(".tmp"))
    assert.deepEqual(leftovers, [], "no temporary or partial file is left behind")
    assert.equal(fs.existsSync(path.join(canonical, "skills-v2.json")), false, "the target is never partially written")
  })

  it("reports current when only the canonical directory exists", () => {
    const base = tempBase()
    const canonical = path.join(base, "oh-my-rigel")
    fs.mkdirSync(canonical, { recursive: true })
    assert.equal(migrateLegacyState({ legacyDir: path.join(base, "ho-my-rigel"), canonicalDir: canonical }).status, "current")
  })

  it("reports absent when neither directory exists", () => {
    const base = tempBase()
    assert.equal(migrateLegacyState({ legacyDir: path.join(base, "ho-my-rigel"), canonicalDir: path.join(base, "oh-my-rigel") }).status, "absent")
  })

  it("resolveStateDir prefers canonical and falls back to legacy", () => {
    const base = tempBase()
    const legacy = path.join(base, "ho-my-rigel")
    const canonical = path.join(base, "oh-my-rigel")
    fs.mkdirSync(legacy, { recursive: true })
    assert.equal(resolveStateDir({ legacyDir: legacy, canonicalDir: canonical }), legacy)
    fs.mkdirSync(canonical, { recursive: true })
    assert.equal(resolveStateDir({ legacyDir: legacy, canonicalDir: canonical }), canonical)
  })
})
