// V1-exact result formatters for the native `glob`/`grep` tools.
// Port of `packages/omo-opencode/src/tools/glob/result-formatter.ts` and
// `.../grep/result-formatter.ts`. The model-visible strings must match V1 byte
// for byte; the host builtin's formats are different and are overwritten by the
// native tools.

export function formatGlobResult(result) {
  if (result.error) return `Error: ${result.error}`
  if (result.files.length === 0) return "No files found"
  const lines = []
  lines.push(`Found ${result.totalFiles} file(s)`)
  lines.push("")
  for (const file of result.files) lines.push(file.path)
  if (result.truncated) {
    lines.push("")
    lines.push("(Results are truncated. Consider using a more specific path or pattern.)")
  }
  return lines.join("\n")
}

export function formatGrepResult(result) {
  if (result.error) return `Error: ${result.error}`
  if (result.matches.length === 0) return "No matches found"
  const lines = []
  const isFilesOnlyMode = result.matches.every((match) => match.line === 0 && match.text.trim() === "")
  lines.push(`Found ${result.totalMatches} match(es) in ${result.filesSearched} file(s)`)
  if (result.truncated) lines.push("[Output truncated due to size limit]")
  lines.push("")
  const byFile = new Map()
  for (const match of result.matches) {
    const existing = byFile.get(match.file) || []
    existing.push(match)
    byFile.set(match.file, existing)
  }
  for (const [file, matches] of byFile) {
    lines.push(file)
    if (!isFilesOnlyMode) {
      for (const match of matches) {
        const trimmedText = match.text.trim()
        if (match.line === 0 && trimmedText === "") continue
        lines.push(`  ${match.line}: ${trimmedText}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n")
}

export function formatCountResult(results) {
  if (results.length === 0) return "No matches found"
  const total = results.reduce((sum, entry) => sum + entry.count, 0)
  const lines = [`Found ${total} match(es) in ${results.length} file(s):`, ""]
  const sorted = [...results].sort((a, b) => b.count - a.count)
  for (const { file, count } of sorted) lines.push(`  ${count.toString().padStart(6)}: ${file}`)
  return lines.join("\n")
}
