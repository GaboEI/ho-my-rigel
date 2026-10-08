/**
 * Port of upstream 34355b5bc (`packages/utils/src/replace-tool-args.ts`):
 * preserve tool-argument identity while making the patch safe for frozen args.
 *
 * OpenCode may freeze the argument object it hands a plugin hook. In-place
 * assignment then throws `TypeError: Attempted to assign to readonly property`,
 * and because tool rules run through an isolated ordered chain the throw is
 * recorded as a rule failure and the patch is lost SILENTLY.
 *
 * `patchToolArgs` keeps identity when the object is mutable (every later hook and
 * the executor share the same object) and replaces the object on the SAME event
 * field with a shallow clone carrying the patch when it is frozen.
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function argsField(event) {
  if (!isPlainObject(event)) return undefined
  if (isPlainObject(event.input)) return "input"
  if (isPlainObject(event.args)) return "args"
  return undefined
}

export function patchToolArgs(event, mutate) {
  const field = argsField(event)
  if (!field || typeof mutate !== "function") return undefined
  const target = event[field]
  if (Object.isFrozen(target)) {
    const clone = { ...target }
    mutate(clone)
    event[field] = clone
    return clone
  }
  mutate(target)
  return target
}
