#!/usr/bin/env bun
/**
 * Recompute web/data/seal.json from the source files.
 *
 * Anti-drift mechanism (see web/README.md): the published site must always be
 * generated from a source sealed with the product version it documents. The seal
 * carries `dataSha256` over the canonical serialization of the source files; a
 * stale or missing seal is a build failure in W7.
 *
 * Run from the repo root: bun web/data/build-seal.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"

import { BASELINE_COMMIT, computeDataSha256, SCHEMA_VERSION, SEALED_FILES } from "./seal-lib.mjs"

const DATA_URL = new URL("./", import.meta.url)
const productVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
const dataSha256 = computeDataSha256(DATA_URL)

const seal = {
  schemaVersion: SCHEMA_VERSION,
  productVersion,
  baselineCommit: BASELINE_COMMIT,
  algorithm: "sha256",
  canonical: "sorted-keys-json",
  sealedFiles: SEALED_FILES,
  dataSha256,
}

writeFileSync(new URL("./seal.json", import.meta.url), JSON.stringify(seal, null, 2) + "\n")
console.log(`seal productVersion=${productVersion} dataSha256=${dataSha256}`)
