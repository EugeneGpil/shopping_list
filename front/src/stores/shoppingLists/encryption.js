import { decryptField, encryptField } from 'src/utils/crypto'

/**
 * The data key for this session, and the two operations the seam needs (§4).
 *
 * A module-level variable rather than store state, deliberately: this is the one value in the
 * app that must never be serialised. Pinia state gets devtools-inspected, deep-watched and —
 * in this store — mirrored into `localStorage` every 300ms, and a `CryptoKey` sitting in that
 * path would be one refactor away from being written to disk in the clear.
 *
 * "Locked" and "encryption is off" are the same state here: no key, so nothing is encrypted or
 * decrypted. What separates them is whether the server says a list is `encrypted`, which is
 * why `openField` refuses rather than guessing.
 */

let dek = null

/** After a successful unwrap, or straight after generating one when encryption is enabled. */
export const setDek = (key) => {
  dek = key
}

/** On logout, or when encryption is switched off. */
export const clearDek = () => {
  dek = null
}

export const getDek = () => dek

export const isUnlocked = () => dek !== null

/**
 * Ciphertext arrived and there is no key to open it with.
 *
 * Its own type because the callers have to tell it apart from a network failure: one means
 * "ask for a fingerprint", the other means "try again later". Both would otherwise surface as
 * a bare `Error` at the same place.
 */
export class EncryptionLockedError extends Error {
  constructor() {
    super('These lists are encrypted and this device is locked.')
    this.name = 'EncryptionLockedError'
  }
}

/** Encrypt one field for the wire. Null and empty stay as they are — see `payloadOf`. */
export const sealField = (text) => encryptField(text, dek)

/**
 * Decrypt one field from the wire.
 *
 * Refuses when locked instead of passing the ciphertext through. Showing base64 where an item
 * name belongs looks like a rendering bug but is the app telling the user their data is
 * corrupt — and worse, a save from that state would write the base64 back as a name.
 */
export const openField = (blob) => {
  if (!dek) throw new EncryptionLockedError()

  return decryptField(blob, dek)
}
