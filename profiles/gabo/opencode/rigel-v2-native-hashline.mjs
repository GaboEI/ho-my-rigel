// Native V2 hashline module: public core API, the read/write output enhancer
// (port of hooks/hashline-read-enhancer), and the hashline_edit tool factory
// (port of tools/hashline-edit). Node builtins only; no npm or TS imports.
//
// The runtime registers the returned definition as `hashline_edit` and wraps it
// with normalizeToolDefinition; `edit` stays owned by OpenCode.

import { readFile, stat, unlink, writeFile } from "node:fs/promises"
import {
  HashlineMismatchError,
  applyHashlineEditsWithReport,
  canonicalizeFileText,
  computeLineHash,
  normalizeHashlineEdits,
  restoreFileText,
} from "./rigel-v2-native-hashline-core.mjs"

export {
  NIBBLE_STR,
  HASHLINE_DICT,
  HASHLINE_REF_PATTERN,
  hashXxh32,
  xxHash32Fallback,
  computeLineHash,
  computeLegacyLineHash,
  formatHashLine,
  formatHashLines,
  normalizeLineRef,
  parseLineRef,
  validateLineRef,
  validateLineRefs,
  HashlineMismatchError,
  normalizeHashlineEdits,
  applyHashlineEdits,
  applyHashlineEditsWithReport,
  applySetLine,
  applyReplaceLines,
  applyInsertAfter,
  applyInsertBefore,
  applyAppend,
  applyPrepend,
  getEditLineNumber,
  collectLineRefs,
  detectOverlappingRanges,
  dedupeEdits,
  toNewLines,
  stripLinePrefixes,
  canonicalizeFileText,
  restoreFileText,
} from "./rigel-v2-native-hashline-core.mjs"

const COLON_READ_LINE_PATTERN = /^\s*(\d+): ?(.*)$/
const PIPE_READ_LINE_PATTERN = /^\s*(\d+)\| ?(.*)$/
const CONTENT_OPEN_TAG = "<content>"
const CONTENT_CLOSE_TAG = "</content>"
const FILE_OPEN_TAG = "<file>"
const FILE_CLOSE_TAG = "</file>"
const OPENCODE_LINE_TRUNCATION_SUFFIX = "... (line truncated to 2000 chars)"
const WRITE_SUCCESS_MARKER = "File written successfully."

function isReadTool(toolName) {
  return toolName.toLowerCase() === "read"
}

function isWriteTool(toolName) {
  return toolName.toLowerCase() === "write"
}

function isTextFile(output) {
  const firstLine = output.split("\n")[0] ?? ""
  return COLON_READ_LINE_PATTERN.test(firstLine) || PIPE_READ_LINE_PATTERN.test(firstLine)
}

function parseReadLine(line) {
  const colonMatch = COLON_READ_LINE_PATTERN.exec(line)
  if (colonMatch) return { lineNumber: Number.parseInt(colonMatch[1], 10), content: colonMatch[2] }
  const pipeMatch = PIPE_READ_LINE_PATTERN.exec(line)
  if (pipeMatch) return { lineNumber: Number.parseInt(pipeMatch[1], 10), content: pipeMatch[2] }
  return null
}

function transformLine(line) {
  const parsed = parseReadLine(line)
  if (!parsed) return line
  if (parsed.content.endsWith(OPENCODE_LINE_TRUNCATION_SUFFIX)) return line
  return `${parsed.lineNumber}#${computeLineHash(parsed.lineNumber, parsed.content)}|${parsed.content}`
}

export function transformReadOutput(output) {
  if (!output) return output

  const lines = output.split("\n")
  const contentStart = lines.findIndex((line) => line === CONTENT_OPEN_TAG || line.startsWith(CONTENT_OPEN_TAG))
  const contentEnd = lines.indexOf(CONTENT_CLOSE_TAG)
  const fileStart = lines.findIndex((line) => line === FILE_OPEN_TAG || line.startsWith(FILE_OPEN_TAG))
  const fileEnd = lines.indexOf(FILE_CLOSE_TAG)

  const blockStart = contentStart !== -1 ? contentStart : fileStart
  const blockEnd = contentStart !== -1 ? contentEnd : fileEnd
  const openTag = contentStart !== -1 ? CONTENT_OPEN_TAG : FILE_OPEN_TAG

  if (blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart) {
    const openLine = lines[blockStart] ?? ""
    const inlineFirst = openLine.startsWith(openTag) && openLine !== openTag ? openLine.slice(openTag.length) : null
    const fileLines = inlineFirst !== null ? [inlineFirst, ...lines.slice(blockStart + 1, blockEnd)] : lines.slice(blockStart + 1, blockEnd)
    if (!isTextFile(fileLines[0] ?? "")) return output

    const result = []
    for (const line of fileLines) {
      if (!parseReadLine(line)) {
        result.push(...fileLines.slice(result.length))
        break
      }
      result.push(transformLine(line))
    }

    const prefixLines = inlineFirst !== null ? [...lines.slice(0, blockStart), openTag] : lines.slice(0, blockStart + 1)
    return [...prefixLines, ...result, ...lines.slice(blockEnd)].join("\n")
  }

  // V2 read output starts with a `Read file <path>, lines X-Y` header followed
  // by the numbered lines. Find the first read line, tag the contiguous run,
  // and preserve the header and any trailing non-read content verbatim.
  const firstReadLine = lines.findIndex((line) => parseReadLine(line) !== null)
  if (firstReadLine === -1) return output

  const result = lines.slice(0, firstReadLine)
  for (let index = firstReadLine; index < lines.length; index += 1) {
    const line = lines[index]
    if (!parseReadLine(line)) {
      result.push(...lines.slice(index))
      break
    }
    result.push(transformLine(line))
  }
  return result.join("\n")
}

function extractFilePath(metadata) {
  if (!metadata || typeof metadata !== "object") return undefined
  const candidates = [metadata.filepath, metadata.filePath, metadata.path, metadata.file]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

function extractLineCount(metadata) {
  if (!metadata || typeof metadata !== "object") return undefined
  const candidates = [metadata.lineCount, metadata.linesWritten, metadata.lines]
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) return candidate
  }
  return undefined
}

export async function transformWriteOutput(output) {
  if (output.output.startsWith(WRITE_SUCCESS_MARKER)) return
  const outputLower = output.output.toLowerCase()
  if (outputLower.startsWith("error") || outputLower.includes("failed")) return

  const metadataLineCount = extractLineCount(output.metadata)
  if (metadataLineCount !== undefined) {
    output.output = `${WRITE_SUCCESS_MARKER} ${metadataLineCount} lines written.`
    return
  }

  const filePath = extractFilePath(output.metadata)
  if (!filePath) return

  let content
  try {
    content = await readFile(filePath, "utf8")
  } catch {
    return
  }
  const lineCount = content === "" ? 0 : content.split("\n").length
  output.output = `${WRITE_SUCCESS_MARKER} ${lineCount} lines written.`
}

export function createHashlineReadEnhancer() {
  return {
    async after(event) {
      if (!event || typeof event !== "object") return false
      if (typeof event.tool !== "string") return false
      if (event.status !== undefined && event.status !== "completed") return false

      const result = event.result
      if (!result || typeof result !== "object") return false

      if (isReadTool(event.tool)) {
        let changed = false
        const content = result.content
        if (typeof content === "string") {
          const next = transformReadOutput(content)
          if (next !== content) {
            result.content = next
            changed = true
          }
          return changed
        }
        if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== "object") continue
            if (part.type !== "text" || typeof part.text !== "string") continue
            const next = transformReadOutput(part.text)
            if (next !== part.text) {
              part.text = next
              changed = true
            }
          }
        }
        return changed
      }

      if (isWriteTool(event.tool)) {
        if (typeof result.content !== "string") return false
        const before = result.content
        const envelope = { output: before, metadata: result.metadata }
        await transformWriteOutput(envelope)
        if (envelope.output === before) return false
        result.content = envelope.output
        return true
      }

      return false
    },
  }
}

export function canCreateFromMissingFile(edits) {
  if (!Array.isArray(edits) || edits.length === 0) return false
  return edits.every((edit) => (edit.op === "append" || edit.op === "prepend") && !edit.pos)
}

const HASHLINE_EDIT_DESCRIPTION = `Edit files using LINE#ID format for precise, safe modifications.

WORKFLOW:
1. Read target file/range and copy exact LINE#ID tags.
2. Pick the smallest operation per logical mutation site.
3. Submit one edit call per file with all related operations.
4. If another call needs the same file, re-read first.

OPERATIONS:
  replace pos only -> replace one line
  replace pos+end -> replace range pos..end inclusive (ranges must not overlap)
  append with pos/end -> insert after that anchor; without anchor -> EOF
  prepend with pos/end -> insert before that anchor; without anchor -> BOF
  replace with lines null or [] -> delete those lines

RULES:
- Anchors are "LINE#ID" only (no trailing "|content"). Copy tags exactly from read output or >>> mismatch output.
- All edits reference the ORIGINAL file state; the system applies them bottom-up. Do not pre-adjust line numbers.
- lines contains only the content inside the consumed range; surrounding lines survive and must not be repeated.
- lines must be plain text (no LINE#ID prefixes, no diff + markers). Use a string or string[].
- Batch related changes as multiple operations in one call. Re-read after a successful call before editing the file again.

FILE MODES:
  delete=true deletes the file and requires edits=[] with no rename.
  rename moves final content to a new path and removes the old path.`

const HASHLINE_EDIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Absolute path to the file to edit" },
    delete: { type: "boolean", description: "Delete file instead of editing" },
    rename: { type: "string", description: "Rename output file path after edits" },
    edits: {
      type: "array",
      description: "Array of edit operations to apply (empty when delete=true)",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["replace", "append", "prepend"],
            description: "Hashline edit operation mode",
          },
          pos: { type: "string", description: "Primary anchor in LINE#ID format" },
          end: { type: "string", description: "Range end anchor in LINE#ID format" },
          lines: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" },
              { type: "null" },
            ],
            description: "Replacement or inserted lines. null deletes with replace",
          },
        },
        required: ["op"],
      },
    },
  },
  required: ["filePath"],
}

async function fileExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export function createHashlineEditTool(context = {}) {
  void context.directory
  return {
    description: HASHLINE_EDIT_DESCRIPTION,
    input: HASHLINE_EDIT_INPUT_SCHEMA,
    execute: async (args) => executeHashlineEdit(args),
  }
}

async function executeHashlineEdit(args) {
  try {
    const filePath = args.filePath
    const deleteMode = args.delete === true
    const rename = args.rename

    if (deleteMode && rename) return "Error: delete and rename cannot be used together"
    if (deleteMode && Array.isArray(args.edits) && args.edits.length > 0) {
      return "Error: delete mode requires edits to be an empty array"
    }
    if (!deleteMode && (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0)) {
      return "Error: edits parameter must be a non-empty array"
    }

    const edits = deleteMode ? [] : normalizeHashlineEdits(args.edits)
    const present = await fileExists(filePath)
    if (!present && !deleteMode && !canCreateFromMissingFile(edits)) {
      return `Error: File not found: ${filePath}`
    }

    if (deleteMode) {
      if (!present) return `Error: File not found: ${filePath}`
      await unlink(filePath)
      return `Successfully deleted ${filePath}`
    }

    const rawOldContent = present ? await readFile(filePath, "utf8") : ""
    const oldEnvelope = canonicalizeFileText(rawOldContent)
    const applyResult = applyHashlineEditsWithReport(oldEnvelope.content, edits)
    const canonicalNewContent = applyResult.content

    if (canonicalNewContent === oldEnvelope.content && !rename) {
      let diagnostic = `No changes made to ${filePath}. The edits produced identical content.`
      if (applyResult.noopEdits > 0) {
        diagnostic += ` No-op edits: ${applyResult.noopEdits}. Re-read the file and provide content that differs from current lines.`
      }
      return `Error: ${diagnostic}`
    }

    const writeContent = restoreFileText(canonicalNewContent, oldEnvelope)
    await writeFile(filePath, writeContent)

    if (rename && rename !== filePath) {
      await writeFile(rename, writeContent)
      await unlink(filePath)
      return `Moved ${filePath} to ${rename}`
    }

    return `Updated ${filePath}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof HashlineMismatchError) {
      return `Error: hash mismatch - ${message}\nTip: reuse LINE#ID entries from the latest read/edit output, or batch related edits in one call.`
    }
    return `Error: ${message}`
  }
}
