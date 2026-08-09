import { describe, it, expect } from 'vitest'
import {
  PRF_SALT,
  decryptField,
  deriveKek,
  encryptField,
  generateDek,
  randomSalt,
  unwrapDek,
  wrapDek,
} from 'src/utils/crypto'

/**
 * The properties `crypto.js` has to have (`docs/go_encrypted.md` §9).
 *
 * These are not "does it run" tests. Each one pins a property whose absence would be invisible
 * in the app and fatal in the data: tampering going undetected, an IV repeating, the wrong
 * credential appearing to work, or a second passkey unwrapping something other than the same
 * key.
 *
 * The PRF itself is stubbed. A real one lives inside an authenticator and cannot be exercised
 * without a fingerprint prompt, which is the device test in §10 — so everything here takes the
 * 32 bytes a passkey *would* hand back and starts from there.
 */

/**
 * Stands in for `navigator.credentials.get()`'s PRF output: 32 bytes that are stable for one
 * credential and unrelated between credentials, which is the only property this code relies on.
 */
const fakePrf = (seed) => {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) % 256

  return bytes
}

const base64ToBytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes))

/** One credential's worth of setup: a salt, a PRF output, and the KEK derived from them. */
async function credential(seed) {
  const salt = randomSalt()

  return { salt, prf: fakePrf(seed), kek: await deriveKek(fakePrf(seed), salt) }
}

describe('field encryption', () => {
  it('round-trips a field', async () => {
    const dek = await generateDek()

    const blob = await encryptField('milk', dek)

    expect(blob).not.toContain('milk')
    expect(await decryptField(blob, dek)).toBe('milk')
  })

  it('round-trips non-ASCII and empty text', async () => {
    const dek = await generateDek()

    // Real lists in this app are mostly Cyrillic; an item can also be blank while being typed.
    for (const text of ['батарейки', 'ไก่ 2 กก.', '', '🥔 x3']) {
      expect(await decryptField(await encryptField(text, dek), dek)).toBe(text)
    }
  })

  it('gives two different ciphertexts for the same plaintext', async () => {
    const dek = await generateDek()

    const [a, b] = [await encryptField('milk', dek), await encryptField('milk', dek)]

    // Equal ciphertexts would mean a reused IV, and would also leak that two lists share an
    // item to anyone reading the database.
    expect(a).not.toBe(b)
  })

  it('uses a fresh IV on every call across a large batch', async () => {
    const dek = await generateDek()
    const count = 500

    const blobs = await Promise.all(Array.from({ length: count }, () => encryptField('milk', dek)))
    const ivs = new Set(blobs.map((blob) => bytesToBase64(base64ToBytes(blob).slice(0, 12))))

    // One repeat in 500 would be enough to break GCM for the pair that shared it, so this
    // asserts every single one is distinct rather than "mostly distinct".
    expect(ivs.size).toBe(count)
  })

  it('refuses a field encrypted under a different data key', async () => {
    const blob = await encryptField('milk', await generateDek())

    await expect(decryptField(blob, await generateDek())).rejects.toThrow()
  })
})

describe('tamper detection', () => {
  /** Flips one bit at `index` of a base64 blob, leaving its length alone. */
  const flipByte = (blob, index) => {
    const bytes = base64ToBytes(blob)
    bytes[index] ^= 1

    return bytesToBase64(bytes)
  }

  it('refuses ciphertext with a flipped bit in the body', async () => {
    const dek = await generateDek()
    const blob = await encryptField('milk', dek)

    // Just past the 12-byte IV: the ciphertext itself.
    await expect(decryptField(flipByte(blob, 13), dek)).rejects.toThrow()
  })

  it('refuses ciphertext with a flipped bit in the tag', async () => {
    const dek = await generateDek()
    const blob = await encryptField('milk', dek)
    const last = base64ToBytes(blob).length - 1

    // The tag is what makes this authenticated rather than merely encrypted; damage there has
    // to fail exactly as loudly as damage to the message.
    await expect(decryptField(flipByte(blob, last), dek)).rejects.toThrow()
  })

  it('refuses ciphertext with a flipped bit in the IV', async () => {
    const dek = await generateDek()
    const blob = await encryptField('milk', dek)

    // The IV travels in the clear, so it is the part an attacker can change most freely — and
    // GCM must still refuse rather than return different plaintext.
    await expect(decryptField(flipByte(blob, 0), dek)).rejects.toThrow()
  })

  it('refuses a truncated blob', async () => {
    const dek = await generateDek()
    const bytes = base64ToBytes(await encryptField('milk', dek))

    await expect(decryptField(bytesToBase64(bytes.slice(0, -4)), dek)).rejects.toThrow()
  })

  it('refuses an empty blob rather than returning empty text', async () => {
    const dek = await generateDek()

    // A row that lost its value must not read back as a list named "".
    await expect(decryptField('', dek)).rejects.toThrow()
  })
})

describe('key derivation', () => {
  it('derives the same wrapping key from the same passkey and salt', async () => {
    const salt = randomSalt()
    const dek = await generateDek()

    const wrapped = await wrapDek(dek, await deriveKek(fakePrf(1), salt))
    const unwrapped = await unwrapDek(wrapped, await deriveKek(fakePrf(1), salt))

    // Unlock is exactly this: derive again on the next boot and expect the same key back.
    expect(await decryptField(await encryptField('milk', dek), unwrapped)).toBe('milk')
  })

  it('derives a different wrapping key when the salt differs', async () => {
    const dek = await generateDek()
    const wrapped = await wrapDek(dek, await deriveKek(fakePrf(1), randomSalt()))

    await expect(unwrapDek(wrapped, await deriveKek(fakePrf(1), randomSalt()))).rejects.toThrow()
  })

  it('keeps the PRF salt fixed, because changing it orphans every wrapped key', () => {
    // Pinned as a value, not a behaviour: an edit to this constant is a data-loss event for
    // every existing user, so it should have to be done deliberately, in two places.
    expect(new TextDecoder().decode(PRF_SALT)).toBe('shopping-list.prf.v1')
  })
})

describe('wrapping the data key', () => {
  it('refuses to unwrap with the wrong credential', async () => {
    const [mine, theirs] = [await credential(1), await credential(2)]
    const wrapped = await wrapDek(await generateDek(), mine.kek)

    // No verification blob exists in this design; the GCM tag failing here *is* the
    // wrong-credential signal, so this is the test that says so.
    await expect(unwrapDek(wrapped, theirs.kek)).rejects.toThrow()
  })

  it('lets two credentials unwrap the same data key', async () => {
    const dek = await generateDek()
    const phone = await credential(1)
    const laptop = await credential(2)

    // What "add a device" does: the same DEK wrapped a second time, under a different PRF
    // output and a different salt.
    const [fromPhone, fromLaptop] = [await wrapDek(dek, phone.kek), await wrapDek(dek, laptop.kek)]
    expect(fromPhone).not.toBe(fromLaptop)

    // The property that makes a second passkey a recovery story: a field written on one device
    // reads on the other. If these unwrapped to different keys, the second passkey would open
    // nothing and the failure would only surface once a list refused to decrypt.
    const blob = await encryptField('milk', await unwrapDek(fromPhone, phone.kek))
    expect(await decryptField(blob, await unwrapDek(fromLaptop, laptop.kek))).toBe('milk')
  })

  it('wraps the same key differently every time', async () => {
    const dek = await generateDek()
    const { kek } = await credential(1)

    // Same key, same KEK, twice: a fresh IV has to make the blobs differ here too.
    expect(await wrapDek(dek, kek)).not.toBe(await wrapDek(dek, kek))
  })

  it('can hand back a non-extractable copy for the remembered-device case', async () => {
    const { kek } = await credential(1)
    const wrapped = await wrapDek(await generateDek(), kek)

    const remembered = await unwrapDek(wrapped, kek, { extractable: false })

    // Stored in IndexedDB this way, the handle still decrypts but its bytes cannot be read
    // back out — which is the whole reason §1 keeps it there rather than in localStorage.
    expect(remembered.extractable).toBe(false)
    await expect(globalThis.crypto.subtle.exportKey('raw', remembered)).rejects.toThrow()
  })

  it('keeps the unwrapped key wrappable, so a further device can be added', async () => {
    const phone = await credential(1)
    const laptop = await credential(2)
    const dek = await generateDek()

    // Adding the second device happens on a device that itself only has an unwrapped copy, so
    // the default unwrap has to stay extractable or the chain stops at two.
    const onPhone = await unwrapDek(await wrapDek(dek, phone.kek), phone.kek)

    await expect(wrapDek(onPhone, laptop.kek)).resolves.toBeTypeOf('string')
  })
})
