/**
 * The crypto for end-to-end encrypted lists (`docs/go_encrypted.md` §3).
 *
 * WebCrypto only — no dependency, and nothing hand-rolled. The envelope this implements:
 * one random data key (DEK) encrypts every field and never changes, and that DEK is stored
 * wrapped under a key derived from each passkey's PRF output (the KEK). Adding a device wraps
 * the same small key again; no list is ever re-encrypted.
 *
 * Pure functions, no Vue, no store access — which is what lets the properties that matter
 * (a fresh IV every call, tampering detected, the wrong key refused) be pinned in `test/`.
 *
 * Deliberately absent: `makeRecoveryKey`. §4 still lists it, but §1 decided there is no
 * recovery code and no password path — a second registered passkey is the entire recovery
 * story. Adding one here would be building the fallback that decision ruled out.
 */

const AES = 'AES-GCM'
const KEY_BITS = 256
const IV_BYTES = 12
const SALT_BYTES = 32

/**
 * The PRF salt, fixed for the lifetime of the app.
 *
 * **This is the most dangerous constant in the design.** A passkey's PRF output is a function
 * of this value, so changing a single byte changes every derived KEK and orphans every wrapped
 * DEK that has ever been stored — every user's lists become unreadable, with no way back. It
 * is not a secret and does not need rotating; it only needs to never change.
 */
export const PRF_SALT = new TextEncoder().encode('shopping-list.prf.v1')

const subtle = () => {
  const api = globalThis.crypto?.subtle
  if (!api) {
    // Browsers only expose WebCrypto on a secure origin. Saying so beats "cannot read
    // properties of undefined" three frames deep in an unlock attempt.
    throw new Error('WebCrypto is unavailable — this needs a secure context (https or localhost).')
  }

  return api
}

const randomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length))

function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

function fromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  return bytes
}

const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)

  return out
}

/** A per-credential HKDF salt, stored beside its wrapped key. Public; useless on its own. */
export function randomSalt() {
  return toBase64(randomBytes(SALT_BYTES))
}

/**
 * The wrapping key for one credential, from its PRF output.
 *
 * HKDF, not PBKDF2, and that is the point: a password KDF exists to make guessing expensive,
 * and this input is already 256 bits held inside an authenticator. There is nothing to
 * brute-force, so stretching it would cost every unlock hundreds of milliseconds and buy
 * nothing.
 *
 * The result is non-extractable and can only wrap and unwrap — it never encrypts a list, and
 * its bytes cannot be read back out of the browser.
 */
export async function deriveKek(prfOutput, saltBase64) {
  const material = await subtle().importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])

  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: fromBase64(saltBase64),
      // Domain separation: the same PRF output under the same salt derives a different key
      // for a different purpose, so a future second use cannot collide with this one.
      info: new TextEncoder().encode('shopping-list.kek.v1'),
    },
    material,
    { name: AES, length: KEY_BITS },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/**
 * A new data key. Generated once, when encryption is switched on, and never changed.
 *
 * Extractable because it has to be wrappable — that is what lets a second passkey be given
 * access without re-encrypting anything. The copy kept on the device can be non-extractable;
 * see `unwrapDek`.
 */
export function generateDek() {
  return subtle().generateKey({ name: AES, length: KEY_BITS }, true, ['encrypt', 'decrypt'])
}

/** The DEK sealed under one credential's KEK, as `base64(iv ‖ wrapped)`. */
export async function wrapDek(dek, kek) {
  const iv = randomBytes(IV_BYTES)
  const wrapped = await subtle().wrapKey('raw', dek, kek, { name: AES, iv })

  return toBase64(concat(iv, new Uint8Array(wrapped)))
}

/**
 * The DEK back out of its envelope.
 *
 * Rejects when the KEK is wrong — GCM's authentication tag fails and that *is* the
 * wrong-credential check, which is why there is no verification blob anywhere in this design.
 *
 * `extractable` defaults to true because a device that can unwrap must also be able to wrap
 * the same key for a new passkey. Pass `false` for the copy handed to IndexedDB under
 * "remember this device": the handle still decrypts, but its bytes cannot be read back out.
 */
export async function unwrapDek(blobBase64, kek, { extractable = true } = {}) {
  const blob = fromBase64(blobBase64)

  return subtle().unwrapKey(
    'raw',
    blob.slice(IV_BYTES),
    kek,
    { name: AES, iv: blob.slice(0, IV_BYTES) },
    { name: AES, length: KEY_BITS },
    extractable,
    ['encrypt', 'decrypt'],
  )
}

/**
 * One field — a list name, an item name, a quantity — as `base64(iv ‖ ciphertext ‖ tag)`.
 *
 * **A fresh IV per call, always.** Reusing one under the same key does not weaken GCM, it
 * breaks it: two ciphertexts under one IV leak the XOR of their plaintexts and, worse, the
 * authentication key itself. Every field of every list goes through here, so this is the line
 * that must never be "optimised" into a shared IV.
 */
export async function encryptField(text, dek) {
  const iv = randomBytes(IV_BYTES)
  const ciphertext = await subtle().encrypt(
    { name: AES, iv },
    dek,
    new TextEncoder().encode(String(text ?? '')),
  )

  return toBase64(concat(iv, new Uint8Array(ciphertext)))
}

/**
 * The plaintext back, or a rejection.
 *
 * A rejection means the bytes are not what was written: the wrong key, a flipped bit, a
 * truncated blob. That is authentication, not a decoding failure, and it must never be
 * softened into returning the raw input — showing base64 as a shopping item would look like a
 * cosmetic bug while actually being silent data corruption.
 */
export async function decryptField(blobBase64, dek) {
  const blob = fromBase64(blobBase64)
  const plain = await subtle().decrypt(
    { name: AES, iv: blob.slice(0, IV_BYTES) },
    dek,
    blob.slice(IV_BYTES),
  )

  return new TextDecoder().decode(plain)
}
