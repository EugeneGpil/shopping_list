/**
 * Just enough ZIP to read a Google Takeout archive in the browser.
 *
 * A Takeout export is ~1700 entries of which only the Keep `.json` files matter, so this
 * walks the central directory and inflates the wanted entries and nothing else — decoding
 * the images and HTML renderings alongside them would cost far more than the parse itself.
 *
 * Deliberately dependency-free: `DecompressionStream` does the only hard part, and a zip
 * library would be a bundle the other 99% of sessions still pay to download.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
// The end record is last in the file but variable length, because a zip comment may follow
// it. 22 bytes is the record itself and 0xffff the largest comment it can declare.
const EOCD_MAX_SEARCH = 22 + 0xffff

const STORED = 0
const DEFLATED = 8

class UnsupportedZip extends Error {}

/** Offset of the end-of-central-directory record, searching back from the tail. */
function findEndRecord(view) {
  const start = Math.max(0, view.byteLength - EOCD_MAX_SEARCH)
  for (let at = view.byteLength - 22; at >= start; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at
  }
  throw new UnsupportedZip('Not a zip file (no end-of-archive record).')
}

async function inflate(bytes, method) {
  if (method === STORED) return bytes
  if (method !== DEFLATED) {
    throw new UnsupportedZip(`Unsupported compression method ${method}.`)
  }
  // 'deflate-raw' rather than 'deflate': zip stores the deflate payload with no zlib
  // wrapper, and the wrapped decoder rejects it outright.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Entries whose name `wanted` accepts, as `{ name, text }`.
 *
 * Only the accepted entries are inflated; the rest cost one central-directory record each.
 */
export async function readZipEntries(arrayBuffer, wanted = () => true) {
  const bytes = new Uint8Array(arrayBuffer)
  const view = new DataView(arrayBuffer)
  const decoder = new TextDecoder()

  const end = findEndRecord(view)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)

  // Both fields saturate when the real values live in a zip64 record. Takeout archives are
  // split well below that, so this is a "cannot happen" that is still worth naming.
  if (at === 0xffffffff || count === 0xffff) {
    throw new UnsupportedZip('Zip64 archives are not supported.')
  }

  const entries = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new UnsupportedZip('Damaged zip: central directory ended early.')
    }
    const method = view.getUint16(at + 10, true)
    const compressedSize = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))

    if (wanted(name)) {
      // The local header repeats the name and extra fields, and its extra field length is
      // not always the central one — the payload starts after whatever this copy declares.
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const from = localOffset + 30 + localNameLength + localExtraLength
      const raw = bytes.subarray(from, from + compressedSize)
      entries.push({ name, text: decoder.decode(await inflate(raw, method)) })
    }

    at += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

export { UnsupportedZip }
