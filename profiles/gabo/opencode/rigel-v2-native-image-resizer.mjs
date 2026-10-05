/**
 * Read-image-resizer decisions for Oh My Rigel's native OpenCode V2 runtime.
 *
 * Plain-JS port of the matching OmO revision:
 *   packages/omo-opencode/src/hooks/read-image-resizer/image-dimensions.ts
 *   packages/omo-opencode/src/hooks/read-image-resizer/image-resizer.ts
 *     ANTHROPIC_MAX_LONG_EDGE = 1568
 *     ANTHROPIC_MAX_FILE_SIZE = 5 * 1024 * 1024
 *     calculateTargetDimensions(width, height, maxLongEdge): null when the long
 *       edge is at or below the cap, else scale the long edge to the cap and
 *       floor the short edge, never below 1.
 *     parseImageDimensions(base64DataUrl, mimeType): signature-based width and
 *       height from the first 32KB of the decoded header (PNG IHDR, GIF8,
 *       JPEG SOF, WebP VP8/VP8L/VP8X).
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so these
 * decisions live here as pure functions. `rigel-v2-native-image-resizer.test.mjs`
 * imports the real TS owners and pins parity across a fixture matrix, so an
 * upstream threshold or parser edit that is not mirrored here fails the suite.
 *
 * SEAM: IMPLEMENTED at `session.hook("http.request")`. The V1 `execute.after`
 * seam is NO-GO (T1: that payload carries no provider, no model, no
 * attachments), but the proven V2 request boundary carries the provider
 * (`input.model.providerID`) and the outgoing image parts (chat `body.messages`,
 * responses `body.input`), so the resize runs there
 * (`rigel-v2-native-request-steps.mjs` `imageResizerStep`).
 *
 * The V1 gate (`providerID === "anthropic"`) is preserved as the default
 * provider set; `RIGEL_IMAGE_RESIZER_PROVIDERS` is a live-QA-only knob that
 * broadens the set (the shipped default stays `["anthropic"]`).
 *
 * The decoder is the runtime's built-in `Bun.Image` (the OpenCode v2.0.22 binary
 * embeds Bun 1.4.2), so no `sharp` and no external decoder dependency is needed.
 * `parseImageDimensions` + `calculateTargetDimensions` remain the pure decision
 * core, parity-pinned against the V1 TypeScript owners.
 *
 * Pure module: no imports, no runtime dependencies, no I/O.
 */

/** Anthropic's maximum image long edge in pixels. */
export const ANTHROPIC_MAX_LONG_EDGE = 1568

/** Anthropic's maximum encoded image size in bytes. */
export const ANTHROPIC_MAX_FILE_SIZE = 5 * 1024 * 1024

/** Header window the dimension parsers read, matching V1. */
export const HEADER_BYTES = 32_768

/** Base64 characters needed to carry HEADER_BYTES bytes. */
export const HEADER_BASE64_CHARS = Math.ceil(HEADER_BYTES / 3) * 4

/** Image mime types the V1 hook resizes for. */
export const SUPPORTED_IMAGE_MIMES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
])

/**
 * Strip a `data:` URL prefix down to its raw base64 payload. A value with no
 * comma after the prefix is returned unchanged (V1 behavior). An empty input
 * returns an empty string, which the callers treat as "no image".
 */
export function extractBase64Data(imageData) {
  if (typeof imageData === "string" && imageData.startsWith("data:")) {
    const commaIndex = imageData.indexOf(",")
    if (commaIndex !== -1) {
      return imageData.slice(commaIndex + 1)
    }
  }
  return typeof imageData === "string" ? imageData : ""
}

function toImageDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }

  if (width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

function parsePngDimensions(buffer) {
  if (buffer.length < 24) {
    return null
  }

  const isPngSignature =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a

  if (!isPngSignature || buffer.toString("ascii", 12, 16) !== "IHDR") {
    return null
  }

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return toImageDimensions(width, height)
}

function parseGifDimensions(buffer) {
  if (buffer.length < 10) {
    return null
  }

  if (buffer.toString("ascii", 0, 4) !== "GIF8") {
    return null
  }

  const width = buffer.readUInt16LE(6)
  const height = buffer.readUInt16LE(8)
  return toImageDimensions(width, height)
}

function parseJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null
  }

  let offset = 2

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }

    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1
    }

    if (offset >= buffer.length) {
      return null
    }

    const marker = buffer[offset]
    offset += 1

    if (marker === 0xd9 || marker === 0xda) {
      break
    }

    if (offset + 1 >= buffer.length) {
      return null
    }

    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2) {
      return null
    }

    if ((marker === 0xc0 || marker === 0xc2) && offset + 7 < buffer.length) {
      const height = buffer.readUInt16BE(offset + 3)
      const width = buffer.readUInt16BE(offset + 5)
      return toImageDimensions(width, height)
    }

    offset += segmentLength
  }

  return null
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

function parseWebpDimensions(buffer) {
  if (buffer.length < 16) {
    return null
  }

  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null
  }

  const chunkType = buffer.toString("ascii", 12, 16)

  if (chunkType === "VP8 ") {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return null
    }

    const width = buffer.readUInt16LE(26) & 0x3fff
    const height = buffer.readUInt16LE(28) & 0x3fff
    return toImageDimensions(width, height)
  }

  if (chunkType === "VP8L") {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      return null
    }

    const bits = buffer.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return toImageDimensions(width, height)
  }

  if (chunkType === "VP8X") {
    const width = readUInt24LE(buffer, 24) + 1
    const height = readUInt24LE(buffer, 27) + 1
    return toImageDimensions(width, height)
  }

  return null
}

/**
 * Parse image dimensions from the first 32KB of a base64 data URL. Returns
 * `{ width, height }` or null when the mime is unsupported, the payload is
 * empty or too short, or the signature does not match. Mirrors V1
 * `parseImageDimensions` including the header-slice window and the
 * decode-in-a-try behavior.
 */
export function parseImageDimensions(base64DataUrl, mimeType) {
  try {
    if (!base64DataUrl || !mimeType) {
      return null
    }

    const rawBase64 = extractBase64Data(base64DataUrl)
    if (!rawBase64) {
      return null
    }

    const headerBase64 = rawBase64.length > HEADER_BASE64_CHARS ? rawBase64.slice(0, HEADER_BASE64_CHARS) : rawBase64
    const buffer = Buffer.from(headerBase64, "base64")
    if (buffer.length === 0) {
      return null
    }

    const normalizedMime = mimeType.toLowerCase()

    if (normalizedMime === "image/png") {
      return parsePngDimensions(buffer)
    }

    if (normalizedMime === "image/gif") {
      return parseGifDimensions(buffer)
    }

    if (normalizedMime === "image/jpeg" || normalizedMime === "image/jpg") {
      return parseJpegDimensions(buffer)
    }

    if (normalizedMime === "image/webp") {
      return parseWebpDimensions(buffer)
    }

    return null
  } catch (error) {
    // Mirror V1: a non-Error throw is not swallowed.
    if (!(error instanceof Error)) {
      throw error
    }
    return null
  }
}

/**
 * Target dimensions for an image that exceeds the long-edge cap, or null when
 * it is already within limits. The long edge becomes exactly `maxLongEdge` and
 * the short edge is floored, never below 1. A non-positive input returns null;
 * mirror V1 exactly, including the missing finite check.
 */
export function calculateTargetDimensions(width, height, maxLongEdge = ANTHROPIC_MAX_LONG_EDGE) {
  if (width <= 0 || height <= 0 || maxLongEdge <= 0) {
    return null
  }

  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) {
    return null
  }

  if (width >= height) {
    return {
      width: maxLongEdge,
      height: Math.max(1, Math.floor((height * maxLongEdge) / width)),
    }
  }

  return {
    width: Math.max(1, Math.floor((width * maxLongEdge) / height)),
    height: maxLongEdge,
  }
}

/**
 * Whether an encoded image is at or under the provider file-size cap. The
 * boundary is inclusive (<= maxFileSize), matching V1's over-limit check
 * (`buffer.length > ANTHROPIC_MAX_FILE_SIZE`).
 */
export function isWithinFileSizeLimit(byteLength, maxFileSize = ANTHROPIC_MAX_FILE_SIZE) {
  if (typeof byteLength !== "number" || !Number.isFinite(byteLength) || byteLength < 0) {
    return false
  }
  return byteLength <= maxFileSize
}

/**
 * Providers whose images the V1 hook resizes. V1 gates on
 * `getSessionModel(sessionID).providerID === "anthropic"`; that stays the
 * default. `RIGEL_IMAGE_RESIZER_PROVIDERS` (comma-separated) broadens the set
 * for live QA only.
 */
export const DEFAULT_RESIZER_PROVIDERS = Object.freeze(["anthropic"])

/** Resolve the resizer provider set from the environment. */
export function resolveResizerProviders(env = process.env) {
  const raw = typeof env?.RIGEL_IMAGE_RESIZER_PROVIDERS === "string" ? env.RIGEL_IMAGE_RESIZER_PROVIDERS : ""
  const parsed = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : DEFAULT_RESIZER_PROVIDERS
}

/** Whether `providerID` is in the resizer provider set. */
export function isResizerProvider(providerID, providers = DEFAULT_RESIZER_PROVIDERS) {
  if (typeof providerID !== "string" || providerID.length === 0) {
    return false
  }
  return providers.includes(providerID.toLowerCase())
}

/** Encoder format for a mime type; gif decodes but re-encodes to png. */
export function resolveResizerFormat(mimeType) {
  const normalized = String(mimeType ?? "").toLowerCase()
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "jpeg"
  }
  if (normalized === "image/webp") {
    return "webp"
  }
  return "png"
}

function canAdjustQuality(format) {
  return format === "jpeg" || format === "webp"
}

async function encodeResizedImage(image, format, quality) {
  const options = typeof quality === "number" ? { quality } : undefined
  const encoded = format === "jpeg"
    ? await image.jpeg(options)
    : format === "webp"
      ? await image.webp(options)
      : await image.png()
  return Buffer.from(await encoded.toBuffer())
}

/**
 * Resize a base64 image data URL with the runtime's built-in `Bun.Image`.
 *
 * Returns `{ resized: false, ... }` when the image is already within limits, the
 * payload is unusable, or `Bun.Image` is unavailable. Returns
 * `{ resized: true, dataUrl, original, resized, originalBytes, resizedBytes }`
 * when the long edge exceeded `maxLongEdge` (or the encoded size exceeded
 * `maxFileSize`). When the re-encoded buffer still exceeds `maxFileSize` for
 * jpeg/webp, it retries at each `qualitySteps` value.
 *
 * `imageCtor` is injectable for tests and defaults to `Bun.Image`. It never
 * throws: every failure is returned as `{ resized: false, reason }`.
 */
export async function resizeImageDataUrl(dataUrl, mimeType, {
  maxLongEdge = ANTHROPIC_MAX_LONG_EDGE,
  maxFileSize = ANTHROPIC_MAX_FILE_SIZE,
  qualitySteps = [80, 60, 40],
  imageCtor,
} = {}) {
  try {
    const ImageCtor = imageCtor ?? (typeof Bun !== "undefined" ? Bun.Image : undefined)
    if (typeof ImageCtor !== "function") {
      return { resized: false, unavailable: true, reason: "Bun.Image unavailable" }
    }

    const rawBase64 = extractBase64Data(dataUrl)
    if (!rawBase64) {
      return { resized: false, reason: "no-data" }
    }

    const inputBuffer = Buffer.from(rawBase64, "base64")
    if (inputBuffer.length === 0) {
      return { resized: false, reason: "empty-buffer" }
    }

    const decoded = new ImageCtor(inputBuffer)
    const metadata = await decoded.metadata()
    if (!metadata || !metadata.width || !metadata.height) {
      return { resized: false, reason: "no-metadata" }
    }

    const original = { width: metadata.width, height: metadata.height }
    const target = calculateTargetDimensions(metadata.width, metadata.height, maxLongEdge)
    const overSize = inputBuffer.length > maxFileSize
    if (!target && !overSize) {
      return { resized: false, original, originalBytes: inputBuffer.length, reason: "within-limits" }
    }

    const outputDims = target ?? original
    const format = resolveResizerFormat(mimeType)
    const source = target
      ? await decoded.resize(target.width, target.height, { fit: "inside" })
      : decoded
    let encoded = await encodeResizedImage(source, format, undefined)
    if (encoded.length > maxFileSize && canAdjustQuality(format)) {
      for (const quality of qualitySteps) {
        encoded = await encodeResizedImage(source, format, quality)
        if (encoded.length <= maxFileSize) {
          break
        }
      }
    }

    const outputMime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png"
    return {
      resized: true,
      dataUrl: `data:${outputMime};base64,${encoded.toString("base64")}`,
      mimeType: outputMime,
      original,
      dimensions: outputDims,
      originalBytes: inputBuffer.length,
      resizedBytes: encoded.length,
    }
  } catch (error) {
    return { resized: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
