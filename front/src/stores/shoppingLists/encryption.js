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

/**
 * The key is here and the bytes still would not open.
 *
 * Its own type for the same reason `EncryptionLockedError` has one: the callers have to tell
 * this apart from the other three ways a read can fail, and it is the only one where nothing
 * this session can do will change the answer — no fingerprint, no retry, no connection.
 * Without it, a page reading "not locked, not offline, not a server answer" concludes the list
 * is gone and navigates away from a list that is still there.
 *
 * **It cannot say which of two things happened**, and must not pretend to. GCM's tag rejects
 * a flipped bit and a wrong key identically, so this covers both a damaged blob and a passkey
 * wrapping a different DEK than the list was written under — an invariant only the client can
 * keep (§5). The message commits to neither, because either is true from here.
 */
export class DecryptionFailedError extends Error {
  constructor(cause) {
    super('This list could not be decrypted with your key.')
    this.name = 'DecryptionFailedError'
    this.cause = cause
  }
}

/**
 * The most plaintext one sealed field can carry, in bytes.
 *
 * Derived from the server's cap rather than chosen here, and written as that arithmetic so the
 * two cannot drift apart: `ShoppingListRequest::MAX_FIELD` admits 10960 characters of base64,
 * which decodes to 10960 / 4 * 3 = 8220 bytes, of which `encryptField` spends 12 on the IV and
 * 16 on the GCM tag. The server's cap stays the authority — this is the client declining to
 * build a request it already knows would be refused.
 *
 * **It has to be counted in bytes, and the server's rule counts characters.** That is the gap
 * it exists to close: the same `max:10960` admits 10960 *characters* of plaintext, so a row that
 * saves in the clear can be over this budget the moment its list is locked — Latin past 8192
 * characters, Cyrillic past 4096, emoji past 2048. Item rows carry no `maxlength`, so pasting
 * reaches it, and what it used to earn was a 422 naming a length nobody can see on screen.
 */
export const MAX_SEALED_BYTES = (10960 / 4) * 3 - (12 + 16)

const encoder = new TextEncoder()

/** Would sealing this text break the budget? Bytes, not characters — see above. */
export const overSealBudget = (text) => encoder.encode(text ?? '').length > MAX_SEALED_BYTES

/**
 * One row is longer than a sealed field can carry.
 *
 * Its own type for the reason the two above have one: `sync.js` has to tell it from `locked`,
 * which holds the same edit back for the same list and needs no words at all, since the key
 * coming back releases it. Nothing releases this one but a shorter row — so it carries which
 * row, because nothing downstream can ask a thirty-item record which item it was.
 */
export class FieldTooLongError extends Error {
  constructor({ listName, rowNumber }) {
    super(`Row ${rowNumber} is too long to encrypt (over ${MAX_SEALED_BYTES} bytes).`)
    this.name = 'FieldTooLongError'
    this.listName = listName
    this.rowNumber = rowNumber
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
 *
 * A rejection from `decryptField` is renamed on the way out and nothing more: it arrives as a
 * bare WebCrypto `OperationError` — or an `atob` `InvalidCharacterError` for bytes that are not
 * base64 at all — which no caller can distinguish from any other failure. `healLegacyTitle`
 * reads it the other way round and still may — see its own note.
 */
export const openField = async (blob) => {
  if (!dek) throw new EncryptionLockedError()

  try {
    return await decryptField(blob, dek)
  } catch (err) {
    throw new DecryptionFailedError(err)
  }
}
