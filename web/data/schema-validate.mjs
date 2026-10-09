/**
 * Minimal JSON Schema (draft 2020-12 subset) validator.
 *
 * The web data source is validated against the real `source.schema.json`: this
 * module interprets the schema keywords that schema actually uses, so the schema
 * is the single source of validation truth rather than an equivalent hand-written
 * test. Supported keywords: $ref (local #/$defs), oneOf, type (string or array of
 * types), required, properties, additionalProperties (false), items, minItems,
 * maxItems, enum, const, pattern, minLength, minimum.
 *
 * Returns an array of error strings; empty means valid.
 */
function typeOf(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function matchesType(value, type) {
  const t = typeOf(value)
  if (type === "integer") return t === "number" && Number.isInteger(value)
  if (type === "number") return t === "number"
  return t === type
}

function resolveRef(ref, root) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`)
  return ref.slice(2).split("/").reduce((node, key) => node[key], root)
}

export function validate(schema, data, root = schema, path = "$") {
  const errors = []
  if (!schema || typeof schema !== "object") return errors

  if (schema.$ref) {
    errors.push(...validate(resolveRef(schema.$ref, root), data, root, path))
    return errors
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => validate(sub, data, root, path).length === 0)
    if (matches.length !== 1) errors.push(`${path}: oneOf matched ${matches.length} branches (expected 1)`)
    return errors
  }

  if (schema.const !== undefined) {
    const same = typeof schema.const === "object" && schema.const !== null
      ? JSON.stringify(data) === JSON.stringify(schema.const)
      : data === schema.const
    if (!same) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`)
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`)
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => matchesType(data, t))) {
      errors.push(`${path}: type ${typeOf(data)} not in ${JSON.stringify(types)}`)
      return errors
    }
  }
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${path}: string shorter than ${schema.minLength}`)
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${path}: ${JSON.stringify(data)} does not match ${schema.pattern}`)
  }
  if (typeof data === "number" && schema.minimum !== undefined && data < schema.minimum) {
    errors.push(`${path}: ${data} < minimum ${schema.minimum}`)
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path}: array shorter than ${schema.minItems}`)
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${path}: array longer than ${schema.maxItems}`)
    if (schema.items) data.forEach((item, i) => errors.push(...validate(schema.items, item, root, `${path}[${i}]`)))
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    if (schema.required) {
      for (const key of schema.required) if (!(key in data)) errors.push(`${path}: missing required "${key}"`)
    }
    if (schema.properties) {
      for (const [key, subschema] of Object.entries(schema.properties)) {
        if (key in data) errors.push(...validate(subschema, data[key], root, `${path}.${key}`))
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(data)) if (!allowed.has(key)) errors.push(`${path}: unexpected property "${key}"`)
    }
  }
  return errors
}

export function loadAndValidate(root, defName, document) {
  return validate({ $ref: `#/$defs/${defName}` }, document, root)
}
