// Native V2 port of packages/hashline-core. Node builtins only; no npm, no TS imports.
// Covers xxHash32, line hashing, LINE#ID validation, edit normalization, and the
// replace/append/prepend apply pipeline used by the hashline_edit tool.

const ENCODER = new TextEncoder()

const PRIME32_1 = 0x9e3779b1
const PRIME32_2 = 0x85ebca77
const PRIME32_3 = 0xc2b2ae3d
const PRIME32_4 = 0x27d4eb2f
const PRIME32_5 = 0x165667b1

function rotateLeft32(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function readUint32LE(input, offset) {
  return (
    ((input[offset] ?? 0) |
      ((input[offset + 1] ?? 0) << 8) |
      ((input[offset + 2] ?? 0) << 16) |
      ((input[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function round32(accumulator, value) {
  const added = (accumulator + Math.imul(value, PRIME32_2)) >>> 0
  return Math.imul(rotateLeft32(added, 13), PRIME32_1) >>> 0
}

function xxHash32Js(input, seed) {
  let offset = 0
  const length = input.length
  let hash

  if (length >= 16) {
    const limit = length - 16
    let value1 = (seed + PRIME32_1 + PRIME32_2) >>> 0
    let value2 = (seed + PRIME32_2) >>> 0
    let value3 = seed >>> 0
    let value4 = (seed - PRIME32_1) >>> 0

    while (offset <= limit) {
      value1 = round32(value1, readUint32LE(input, offset))
      offset += 4
      value2 = round32(value2, readUint32LE(input, offset))
      offset += 4
      value3 = round32(value3, readUint32LE(input, offset))
      offset += 4
      value4 = round32(value4, readUint32LE(input, offset))
      offset += 4
    }

    hash = (rotateLeft32(value1, 1) + rotateLeft32(value2, 7)) >>> 0
    hash = (hash + rotateLeft32(value3, 12)) >>> 0
    hash = (hash + rotateLeft32(value4, 18)) >>> 0
  } else {
    hash = (seed + PRIME32_5) >>> 0
  }

  hash = (hash + length) >>> 0

  while (offset + 4 <= length) {
    hash = (hash + Math.imul(readUint32LE(input, offset), PRIME32_3)) >>> 0
    hash = Math.imul(rotateLeft32(hash, 17), PRIME32_4) >>> 0
    offset += 4
  }

  while (offset < length) {
    hash = (hash + Math.imul(input[offset] ?? 0, PRIME32_5)) >>> 0
    hash = Math.imul(rotateLeft32(hash, 11), PRIME32_1) >>> 0
    offset += 1
  }

  hash = (hash ^ (hash >>> 15)) >>> 0
  hash = Math.imul(hash, PRIME32_2) >>> 0
  hash = (hash ^ (hash >>> 13)) >>> 0
  hash = Math.imul(hash, PRIME32_3) >>> 0
  return (hash ^ (hash >>> 16)) >>> 0
}

export function xxHash32Fallback(input, seed) {
  return xxHash32Js(ENCODER.encode(input), seed >>> 0)
}

export function hashXxh32(input, seed) {
  const bun = globalThis.Bun
  if (bun !== undefined) return bun.hash.xxHash32(input, seed)
  return xxHash32Js(ENCODER.encode(input), seed >>> 0)
}

export const NIBBLE_STR = "ZPMQVRWSNKTXJBYH"

export const HASHLINE_DICT = Array.from({ length: 256 }, (_, i) => {
  const high = i >>> 4
  const low = i & 0x0f
  return `${NIBBLE_STR[high]}${NIBBLE_STR[low]}`
})

export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/

const LINE_REF_EXTRACT_PATTERN = /([0-9]+#[ZPMQVRWSNKTXJBYH]{2})/
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u
const MISMATCH_CONTEXT = 2

function computeNormalizedLineHash(lineNumber, normalizedContent) {
  const seed = RE_SIGNIFICANT.test(normalizedContent) ? 0 : lineNumber
  return HASHLINE_DICT[hashXxh32(normalizedContent, seed) % 256]
}

export function computeLineHash(lineNumber, content) {
  return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").trimEnd())
}

export function computeLegacyLineHash(lineNumber, content) {
  return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").replace(/\s+/g, ""))
}

export function formatHashLine(lineNumber, content) {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`
}

export function formatHashLines(content) {
  if (!content) return ""
  return content
    .split("\n")
    .map((line, index) => formatHashLine(index + 1, line))
    .join("\n")
}

function isCompatibleLineHash(line, content, hash) {
  return computeLineHash(line, content) === hash || computeLegacyLineHash(line, content) === hash
}

export function normalizeLineRef(ref) {
  const originalTrimmed = ref.trim()
  let trimmed = originalTrimmed
  trimmed = trimmed.replace(/^(?:>>>|[+-])\s*/, "")
  trimmed = trimmed.replace(/\s*#\s*/, "#")
  trimmed = trimmed.replace(/\|.*$/, "")
  trimmed = trimmed.trim()

  if (HASHLINE_REF_PATTERN.test(trimmed)) return trimmed

  const extracted = trimmed.match(LINE_REF_EXTRACT_PATTERN)
  if (extracted) return extracted[1]

  return originalTrimmed
}

export function parseLineRef(ref) {
  const normalized = normalizeLineRef(ref)
  const match = normalized.match(HASHLINE_REF_PATTERN)
  if (match) {
    return { line: Number.parseInt(match[1], 10), hash: match[2] }
  }
  const hashIdx = normalized.indexOf("#")
  if (hashIdx > 0) {
    const prefix = normalized.slice(0, hashIdx)
    const suffix = normalized.slice(hashIdx + 1)
    if (!/^\d+$/.test(prefix) && /^[ZPMQVRWSNKTXJBYH]{2}$/.test(suffix)) {
      throw new Error(
        `Invalid line reference: "${ref}". "${prefix}" is not a line number. ` +
          "Use the actual line number from the read output."
      )
    }
  }
  throw new Error(`Invalid line reference format: "${ref}". Expected format: "{line_number}#{hash_id}"`)
}

export class HashlineMismatchError extends Error {
  constructor(mismatches, fileLines) {
    super(HashlineMismatchError.formatMessage(mismatches, fileLines))
    this.name = "HashlineMismatchError"
    this.mismatches = mismatches
    this.fileLines = fileLines
    const remaps = new Map()
    for (const mismatch of mismatches) {
      const actual = computeLineHash(mismatch.line, fileLines[mismatch.line - 1] ?? "")
      remaps.set(`${mismatch.line}#${mismatch.expected}`, `${mismatch.line}#${actual}`)
    }
    this.remaps = remaps
  }

  static formatMessage(mismatches, fileLines) {
    const mismatchByLine = new Map()
    for (const mismatch of mismatches) mismatchByLine.set(mismatch.line, mismatch)

    const displayLines = new Set()
    for (const mismatch of mismatches) {
      const low = Math.max(1, mismatch.line - MISMATCH_CONTEXT)
      const high = Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT)
      for (let line = low; line <= high; line++) displayLines.add(line)
    }

    const sortedLines = [...displayLines].sort((a, b) => a - b)
    const output = []
    output.push(
      `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. ` +
        "Use updated {line_number}#{hash_id} references below (>>> marks changed lines)."
    )
    output.push("")

    let previousLine = -1
    for (const line of sortedLines) {
      if (previousLine !== -1 && line > previousLine + 1) output.push("    ...")
      previousLine = line
      const content = fileLines[line - 1] ?? ""
      const hash = computeLineHash(line, content)
      const prefix = `${line}#${hash}|${content}`
      output.push(mismatchByLine.has(line) ? `>>> ${prefix}` : `    ${prefix}`)
    }

    return output.join("\n")
  }
}

function suggestLineForHash(ref, lines) {
  const hashMatch = ref.trim().match(/#([ZPMQVRWSNKTXJBYH]{2})$/)
  if (!hashMatch) return null
  const hash = hashMatch[1]
  for (let i = 0; i < lines.length; i++) {
    if (isCompatibleLineHash(i + 1, lines[i], hash)) {
      return `Did you mean "${i + 1}#${computeLineHash(i + 1, lines[i])}"?`
    }
  }
  return null
}

function parseLineRefWithHint(ref, lines) {
  try {
    return parseLineRef(ref)
  } catch (parseError) {
    const hint = suggestLineForHash(ref, lines)
    if (hint && parseError instanceof Error) throw new Error(`${parseError.message} ${hint}`)
    throw parseError
  }
}

export function validateLineRef(lines, ref) {
  const { line, hash } = parseLineRefWithHint(ref, lines)
  if (line < 1 || line > lines.length) {
    throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`)
  }
  if (!isCompatibleLineHash(line, lines[line - 1], hash)) {
    throw new HashlineMismatchError([{ line, expected: hash }], lines)
  }
}

export function validateLineRefs(lines, refs) {
  const mismatches = []
  for (const ref of refs) {
    const { line, hash } = parseLineRefWithHint(ref, lines)
    if (line < 1 || line > lines.length) {
      throw new Error(`Line number ${line} out of bounds (file has ${lines.length} lines)`)
    }
    if (!isCompatibleLineHash(line, lines[line - 1], hash)) mismatches.push({ line, expected: hash })
  }
  if (mismatches.length > 0) throw new HashlineMismatchError(mismatches, lines)
}

function normalizeAnchor(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function requireLines(edit, index) {
  if (edit.lines === undefined) {
    throw new Error(`Edit ${index}: lines is required for ${edit.op ?? "unknown"}`)
  }
  if (edit.lines === null) return []
  return edit.lines
}

function requireLine(anchor, index, op) {
  if (!anchor) {
    throw new Error(`Edit ${index}: ${op} requires at least one anchor line reference (pos or end)`)
  }
  return anchor
}

export function normalizeHashlineEdits(rawEdits) {
  return rawEdits.map((rawEdit, index) => {
    const edit = rawEdit ?? {}
    const pos = normalizeAnchor(edit.pos)
    const end = normalizeAnchor(edit.end)

    switch (edit.op) {
      case "replace": {
        const anchor = requireLine(pos ?? end, index, "replace")
        const lines = requireLines(edit, index)
        const normalized = { op: "replace", pos: anchor, lines }
        if (end) normalized.end = end
        return normalized
      }
      case "append": {
        const lines = requireLines(edit, index)
        const normalized = { op: "append", lines }
        const anchor = pos ?? end
        if (anchor) normalized.pos = anchor
        return normalized
      }
      case "prepend": {
        const lines = requireLines(edit, index)
        const normalized = { op: "prepend", lines }
        const anchor = pos ?? end
        if (anchor) normalized.pos = anchor
        return normalized
      }
      default:
        throw new Error(
          `Edit ${index}: unsupported op "${String(edit.op)}". ` +
            "Legacy format was removed; use op/pos/end/lines."
        )
    }
  })
}

const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}\|/
const DIFF_PLUS_RE = /^[+](?![+])/

function equalsIgnoringWhitespace(a, b) {
  if (a === b) return true
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "")
}

function leadingWhitespace(text) {
  if (!text) return ""
  const match = text.match(/^\s*/)
  return match ? match[0] : ""
}

export function stripLinePrefixes(lines) {
  let hashPrefixCount = 0
  let diffPlusCount = 0
  let nonEmpty = 0

  for (const line of lines) {
    if (line.length === 0) continue
    nonEmpty += 1
    if (HASHLINE_PREFIX_RE.test(line)) hashPrefixCount += 1
    if (DIFF_PLUS_RE.test(line)) diffPlusCount += 1
  }

  if (nonEmpty === 0) return lines

  const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5
  const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5
  if (!stripHash && !stripPlus) return lines

  return lines.map((line) => {
    if (stripHash) return line.replace(HASHLINE_PREFIX_RE, "")
    if (stripPlus) return line.replace(DIFF_PLUS_RE, "")
    return line
  })
}

export function toNewLines(input) {
  if (Array.isArray(input)) return stripLinePrefixes(input)
  return stripLinePrefixes(input.split("\n"))
}

export function restoreLeadingIndent(templateLine, line) {
  if (line.length === 0) return line
  const templateIndent = leadingWhitespace(templateLine)
  if (templateIndent.length === 0) return line
  if (leadingWhitespace(line).length > 0) return line
  if (templateLine.trim() === line.trim()) return line
  return `${templateIndent}${line}`
}

export function stripInsertAnchorEcho(anchorLine, newLines) {
  if (newLines.length === 0) return newLines
  if (equalsIgnoringWhitespace(newLines[0], anchorLine)) return newLines.slice(1)
  return newLines
}

export function stripInsertBeforeEcho(anchorLine, newLines) {
  if (newLines.length <= 1) return newLines
  if (equalsIgnoringWhitespace(newLines[newLines.length - 1], anchorLine)) return newLines.slice(0, -1)
  return newLines
}

export function stripInsertBoundaryEcho(afterLine, beforeLine, newLines) {
  let out = newLines
  if (out.length > 0 && equalsIgnoringWhitespace(out[0], afterLine)) out = out.slice(1)
  if (out.length > 0 && equalsIgnoringWhitespace(out[out.length - 1], beforeLine)) out = out.slice(0, -1)
  return out
}

export function stripRangeBoundaryEcho(lines, startLine, endLine, newLines) {
  const replacedCount = endLine - startLine + 1
  if (newLines.length <= 1 || newLines.length <= replacedCount) return newLines

  let out = newLines
  const beforeIdx = startLine - 2
  if (beforeIdx >= 0 && out[0] === lines[beforeIdx]) out = out.slice(1)

  const afterIdx = endLine
  if (afterIdx < lines.length && out.length > 0 && out[out.length - 1] === lines[afterIdx]) {
    out = out.slice(0, -1)
  }
  return out
}

function normalizeTokens(text) {
  return text.replace(/\s+/g, "")
}

function stripAllWhitespace(text) {
  return normalizeTokens(text)
}

export function stripTrailingContinuationTokens(text) {
  return text.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "")
}

export function stripMergeOperatorChars(text) {
  return text.replace(/[|&?]/g, "")
}

export function restoreOldWrappedLines(originalLines, replacementLines) {
  if (originalLines.length === 0 || replacementLines.length < 2) return replacementLines

  const canonicalToOriginal = new Map()
  for (const line of originalLines) {
    const canonical = stripAllWhitespace(line)
    const existing = canonicalToOriginal.get(canonical)
    if (existing) existing.count += 1
    else canonicalToOriginal.set(canonical, { line, count: 1 })
  }

  const candidates = []
  for (let start = 0; start < replacementLines.length; start += 1) {
    for (let len = 2; len <= 10 && start + len <= replacementLines.length; len += 1) {
      const span = replacementLines.slice(start, start + len)
      if (span.some((line) => line.trim().length === 0)) continue
      const canonicalSpan = stripAllWhitespace(span.join(""))
      const original = canonicalToOriginal.get(canonicalSpan)
      if (original && original.count === 1 && canonicalSpan.length >= 6) {
        candidates.push({ start, len, replacement: original.line, canonical: canonicalSpan })
      }
    }
  }
  if (candidates.length === 0) return replacementLines

  const canonicalCounts = new Map()
  for (const candidate of candidates) {
    canonicalCounts.set(candidate.canonical, (canonicalCounts.get(candidate.canonical) ?? 0) + 1)
  }

  const uniqueCandidates = candidates.filter((candidate) => (canonicalCounts.get(candidate.canonical) ?? 0) === 1)
  if (uniqueCandidates.length === 0) return replacementLines

  uniqueCandidates.sort((a, b) => b.start - a.start)
  const correctedLines = [...replacementLines]
  for (const candidate of uniqueCandidates) {
    correctedLines.splice(candidate.start, candidate.len, candidate.replacement)
  }
  return correctedLines
}

export function maybeExpandSingleLineMerge(originalLines, replacementLines) {
  if (replacementLines.length !== 1 || originalLines.length <= 1) return replacementLines

  const merged = replacementLines[0]
  const parts = originalLines.map((line) => line.trim()).filter((line) => line.length > 0)
  if (parts.length !== originalLines.length) return replacementLines

  const indices = []
  let offset = 0
  let orderedMatch = true
  for (const part of parts) {
    let idx = merged.indexOf(part, offset)
    let matchedLen = part.length
    if (idx === -1) {
      const stripped = stripTrailingContinuationTokens(part)
      if (stripped !== part) {
        idx = merged.indexOf(stripped, offset)
        if (idx !== -1) matchedLen = stripped.length
      }
    }
    if (idx === -1) {
      const segment = merged.slice(offset)
      const segmentStripped = stripMergeOperatorChars(segment)
      const partStripped = stripMergeOperatorChars(part)
      const fuzzyIdx = segmentStripped.indexOf(partStripped)
      if (fuzzyIdx !== -1) {
        let strippedPos = 0
        let originalPos = 0
        while (strippedPos < fuzzyIdx && originalPos < segment.length) {
          if (!/[|&?]/.test(segment[originalPos])) strippedPos += 1
          originalPos += 1
        }
        idx = offset + originalPos
        matchedLen = part.length
      }
    }
    if (idx === -1) {
      orderedMatch = false
      break
    }
    indices.push(idx)
    offset = idx + matchedLen
  }

  const expanded = []
  if (orderedMatch) {
    for (let i = 0; i < indices.length; i += 1) {
      const start = indices[i]
      const end = i + 1 < indices.length ? indices[i + 1] : merged.length
      const candidate = merged.slice(start, end).trim()
      if (candidate.length === 0) {
        orderedMatch = false
        break
      }
      expanded.push(candidate)
    }
  }

  if (orderedMatch && expanded.length === originalLines.length) return expanded

  const semicolonSplit = merged
    .split(/;\s+/)
    .map((line, idx, arr) => (idx < arr.length - 1 && !line.endsWith(";") ? `${line};` : line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (semicolonSplit.length === originalLines.length) return semicolonSplit

  return replacementLines
}

export function restoreIndentForPairedReplacement(originalLines, replacementLines) {
  if (originalLines.length !== replacementLines.length) return replacementLines
  return replacementLines.map((line, idx) => {
    if (line.length === 0) return line
    if (leadingWhitespace(line).length > 0) return line
    const indent = leadingWhitespace(originalLines[idx])
    if (indent.length === 0) return line
    if (originalLines[idx].trim() === line.trim()) return line
    return `${indent}${line}`
  })
}

export function autocorrectReplacementLines(originalLines, replacementLines) {
  let next = replacementLines
  next = maybeExpandSingleLineMerge(originalLines, next)
  next = restoreOldWrappedLines(originalLines, next)
  next = restoreIndentForPairedReplacement(originalLines, next)
  return next
}

function shouldValidate(options) {
  return options?.skipValidation !== true
}

export function applySetLine(lines, anchor, newText, options) {
  if (shouldValidate(options)) validateLineRef(lines, anchor)
  const { line } = parseLineRef(anchor)
  const result = [...lines]
  const originalLine = lines[line - 1] ?? ""
  const corrected = autocorrectReplacementLines([originalLine], toNewLines(newText))
  const replacement = corrected.map((entry, idx) => (idx === 0 ? restoreLeadingIndent(originalLine, entry) : entry))
  result.splice(line - 1, 1, ...replacement)
  return result
}

export function applyReplaceLines(lines, startAnchor, endAnchor, newText, options) {
  if (shouldValidate(options)) {
    validateLineRef(lines, startAnchor)
    validateLineRef(lines, endAnchor)
  }
  const { line: startLine } = parseLineRef(startAnchor)
  const { line: endLine } = parseLineRef(endAnchor)
  if (startLine > endLine) {
    throw new Error(`Invalid range: start line ${startLine} cannot be greater than end line ${endLine}`)
  }
  const result = [...lines]
  const originalRange = lines.slice(startLine - 1, endLine)
  const stripped = stripRangeBoundaryEcho(lines, startLine, endLine, toNewLines(newText))
  const corrected = autocorrectReplacementLines(originalRange, stripped)
  const restored = corrected.map((entry, idx) =>
    idx === 0 ? restoreLeadingIndent(lines[startLine - 1] ?? "", entry) : entry
  )
  result.splice(startLine - 1, endLine - startLine + 1, ...restored)
  return result
}

export function applyInsertAfter(lines, anchor, text, options) {
  if (shouldValidate(options)) validateLineRef(lines, anchor)
  const { line } = parseLineRef(anchor)
  const result = [...lines]
  const newLines = stripInsertAnchorEcho(lines[line - 1], toNewLines(text))
  if (newLines.length === 0) throw new Error(`append (anchored) requires non-empty text for ${anchor}`)
  result.splice(line, 0, ...newLines)
  return result
}

export function applyInsertBefore(lines, anchor, text, options) {
  if (shouldValidate(options)) validateLineRef(lines, anchor)
  const { line } = parseLineRef(anchor)
  const result = [...lines]
  const newLines = stripInsertBeforeEcho(lines[line - 1], toNewLines(text))
  if (newLines.length === 0) throw new Error(`prepend (anchored) requires non-empty text for ${anchor}`)
  result.splice(line - 1, 0, ...newLines)
  return result
}

export function applyAppend(lines, text) {
  const normalized = toNewLines(text)
  if (normalized.length === 0) throw new Error("append requires non-empty text")
  if (lines.length === 1 && lines[0] === "") return [...normalized]
  return [...lines, ...normalized]
}

export function applyPrepend(lines, text) {
  const normalized = toNewLines(text)
  if (normalized.length === 0) throw new Error("prepend requires non-empty text")
  if (lines.length === 1 && lines[0] === "") return [...normalized]
  return [...normalized, ...lines]
}

export function getEditLineNumber(edit) {
  switch (edit.op) {
    case "replace":
      return parseLineRef(edit.end ?? edit.pos).line
    case "append":
      return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY
    case "prepend":
      return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY
    default:
      return Number.POSITIVE_INFINITY
  }
}

export function collectLineRefs(edits) {
  return edits.flatMap((edit) => {
    switch (edit.op) {
      case "replace":
        return edit.end ? [edit.pos, edit.end] : [edit.pos]
      case "append":
      case "prepend":
        return edit.pos ? [edit.pos] : []
      default:
        return []
    }
  })
}

export function detectOverlappingRanges(edits) {
  const ranges = []
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    if (edit.op !== "replace" || !edit.end) continue
    ranges.push({ start: parseLineRef(edit.pos).line, end: parseLineRef(edit.end).line, idx: i })
  }
  if (ranges.length < 2) return null

  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]
    const curr = ranges[i]
    if (curr.start <= prev.end) {
      return (
        "Overlapping range edits detected: " +
        `edit ${prev.idx + 1} (lines ${prev.start}-${prev.end}) overlaps with ` +
        `edit ${curr.idx + 1} (lines ${curr.start}-${curr.end}). ` +
        "Use pos-only replace for single-line edits."
      )
    }
  }
  return null
}

function normalizeEditPayload(payload) {
  return toNewLines(payload).join("\n")
}

function canonicalAnchor(anchor) {
  if (!anchor) return ""
  return normalizeLineRef(anchor)
}

function buildDedupeKey(edit) {
  switch (edit.op) {
    case "replace":
      return `replace|${canonicalAnchor(edit.pos)}|${edit.end ? canonicalAnchor(edit.end) : ""}|${normalizeEditPayload(edit.lines)}`
    case "append":
      return `append|${canonicalAnchor(edit.pos)}|${normalizeEditPayload(edit.lines)}`
    case "prepend":
      return `prepend|${canonicalAnchor(edit.pos)}|${normalizeEditPayload(edit.lines)}`
    default:
      return JSON.stringify(edit)
  }
}

export function dedupeEdits(edits) {
  const seen = new Set()
  const deduped = []
  let deduplicatedEdits = 0

  for (const edit of edits) {
    const key = buildDedupeKey(edit)
    if (seen.has(key)) {
      deduplicatedEdits += 1
      continue
    }
    seen.add(key)
    deduped.push(edit)
  }

  return { edits: deduped, deduplicatedEdits }
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const EDIT_PRECEDENCE = { replace: 0, append: 1, prepend: 2 }

export function applyHashlineEditsWithReport(content, edits) {
  if (edits.length === 0) return { content, noopEdits: 0, deduplicatedEdits: 0 }

  const dedupeResult = dedupeEdits(edits)
  const sortedEdits = [...dedupeResult.edits].sort((a, b) => {
    const lineA = getEditLineNumber(a)
    const lineB = getEditLineNumber(b)
    if (lineB !== lineA) return lineB - lineA
    return (EDIT_PRECEDENCE[a.op] ?? 3) - (EDIT_PRECEDENCE[b.op] ?? 3)
  })

  let noopEdits = 0
  let lines = content.length === 0 ? [] : content.split("\n")

  const refs = collectLineRefs(sortedEdits)
  validateLineRefs(lines, refs)

  const overlapError = detectOverlappingRanges(sortedEdits)
  if (overlapError) throw new Error(overlapError)

  for (const edit of sortedEdits) {
    switch (edit.op) {
      case "replace": {
        const next = edit.end
          ? applyReplaceLines(lines, edit.pos, edit.end, edit.lines, { skipValidation: true })
          : applySetLine(lines, edit.pos, edit.lines, { skipValidation: true })
        if (arraysEqual(next, lines)) {
          noopEdits += 1
          break
        }
        lines = next
        break
      }
      case "append": {
        const next = edit.pos
          ? applyInsertAfter(lines, edit.pos, edit.lines, { skipValidation: true })
          : applyAppend(lines, edit.lines)
        if (arraysEqual(next, lines)) {
          noopEdits += 1
          break
        }
        lines = next
        break
      }
      case "prepend": {
        const next = edit.pos
          ? applyInsertBefore(lines, edit.pos, edit.lines, { skipValidation: true })
          : applyPrepend(lines, edit.lines)
        if (arraysEqual(next, lines)) {
          noopEdits += 1
          break
        }
        lines = next
        break
      }
    }
  }

  return { content: lines.join("\n"), noopEdits, deduplicatedEdits: dedupeResult.deduplicatedEdits }
}

export function applyHashlineEdits(content, edits) {
  return applyHashlineEditsWithReport(content, edits).content
}

function detectLineEnding(content) {
  const crlfIndex = content.indexOf("\r\n")
  const lfIndex = content.indexOf("\n")
  if (lfIndex === -1) return "\n"
  if (crlfIndex === -1) return "\n"
  return crlfIndex < lfIndex ? "\r\n" : "\n"
}

function stripBom(content) {
  if (!content.startsWith("\uFEFF")) return { content, hadBom: false }
  return { content: content.slice(1), hadBom: true }
}

function normalizeToLf(content) {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function restoreLineEndings(content, lineEnding) {
  if (lineEnding === "\n") return content
  return content.replace(/\n/g, "\r\n")
}

export function canonicalizeFileText(content) {
  const stripped = stripBom(content)
  return {
    content: normalizeToLf(stripped.content),
    hadBom: stripped.hadBom,
    lineEnding: detectLineEnding(stripped.content),
  }
}

export function restoreFileText(content, envelope) {
  const withLineEnding = restoreLineEndings(content, envelope.lineEnding)
  if (!envelope.hadBom) return withLineEnding
  return `\uFEFF${withLineEnding}`
}
