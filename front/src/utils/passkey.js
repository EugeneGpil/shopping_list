/**
 * The passkey half of the envelope (`docs/go_encrypted.md` §2a): a credential that hands back
 * a stable 32-byte secret after a fingerprint, and nothing else.
 *
 * **This is not authentication.** No assertion is ever sent to the server and nothing verifies
 * a signature — sign-in is Google's job and stays that way. What WebAuthn is used for here is
 * one property only: the `prf` extension returns the same bytes for the same salt, on any
 * device the credential syncs to, and only after user verification. That is a key store with a
 * fingerprint in front of it, so the challenges below are random local values with nothing
 * riding on them.
 *
 * Everything here is about *getting* the PRF output. Turning it into a wrapping key, and
 * wrapping the DEK with it, is `utils/crypto.js`.
 */

import { PRF_SALT } from './crypto'

const RP_NAME = 'Shopping list'

/** ES256 first — what every platform authenticator does — with RS256 as the fallback. */
const ALGORITHMS = [
  { type: 'public-key', alg: -7 },
  { type: 'public-key', alg: -257 },
]

/**
 * How long the platform is given to produce an answer, on both `create()` and `get()`.
 *
 * **Not an optimisation — without it the promise may never settle.** The field is optional and
 * a browser is allowed to wait forever; with every authenticator gone, `encryption.busy` stayed
 * true past 30 seconds with nothing on screen but a spinning button, and only resolved when a
 * device appeared. On a phone the platform dialog bounds this by itself, so what this covers is
 * the case where nothing ever answers: no authenticator, a security key never plugged in, a
 * cross-device prompt nobody picks up.
 *
 * 60s is WebAuthn's own convention and what the spec's examples use, and the reason it is not
 * shorter is who pays for being wrong: a person walking to the laptop with the security key in a
 * drawer, or finding where the fingerprint reader is on a machine they rarely use, gets one
 * refusal and has to start again. A minute of spinner after a genuinely dead authenticator is
 * the cheaper mistake. It is also inside the range browsers clamp to, so the number asked for is
 * the number used rather than being silently rewritten.
 */
const TIMEOUT_MS = 60_000

/**
 * The platform said no to PRF.
 *
 * Its own type because it is the one failure that is not worth retrying: §2b decided this
 * app refuses to encrypt rather than fall back to a password, so the caller has to tell it
 * apart from a cancelled prompt.
 */
export class PrfUnsupportedError extends Error {
  constructor(message = 'This browser or passkey cannot produce the secret this needs.') {
    super(message)
    this.name = 'PrfUnsupportedError'
  }
}

/**
 * The platform refused, and will not say why.
 *
 * WebAuthn deliberately collapses several outcomes into one `NotAllowedError` — the prompt was
 * dismissed, it timed out, there was no credential this device could use, the origin was not
 * allowed — because telling a page which one happened is itself a leak. So the message here
 * covers the ground rather than guessing, and callers must **show it**: treating this as
 * "the user changed their mind" and staying silent leaves a button that does nothing, which
 * is exactly how it feels when the device has no passkey that can open these lists.
 *
 * **The `TIMEOUT_MS` expiry arrives here too, and is not separated out.** It could be guessed at
 * — the deadline is ours, so an elapsed minute is a strong hint — but a prompt left standing for
 * a minute and then dismissed is the same elapsed minute, so the guess would be presented as a
 * fact for no gain: all three cases offer the user the same thing, which is to try again. So the
 * message names the third case instead of ranking them.
 */
export class PasskeyCancelledError extends Error {
  constructor(cause) {
    super(
      'No passkey was used — the prompt was dismissed, nothing answered in time, or this ' +
        'device has no passkey registered for these lists.',
    )
    this.name = 'PasskeyCancelledError'
    this.cause = cause
  }
}

const encoder = new TextEncoder()

const randomChallenge = () => globalThis.crypto.getRandomValues(new Uint8Array(32))

/**
 * base64url, because a credential id travels in JSON and comes back in a URL query.
 * Standard base64 would put `+` and `/` in both.
 */
export function toBase64Url(buffer) {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  return bytes
}

/** Is there a WebAuthn API here at all? False in an insecure context and in old browsers. */
export const isPasskeySupported = () =>
  typeof globalThis.PublicKeyCredential !== 'undefined' &&
  typeof navigator.credentials?.create === 'function'

/**
 * Is there an authenticator built into this device — a fingerprint reader, Windows Hello,
 * Android's screen lock?
 *
 * Asked before offering setup, not to gate it: a security key on USB works too, so a false
 * here is a reason to warn rather than to refuse. Firefox answers true and still has no PRF,
 * which is why this is not the check that matters (§2b).
 */
export async function hasPlatformAuthenticator() {
  if (!isPasskeySupported()) return false
  try {
    return await globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

const prfResults = (credential) => credential.getClientExtensionResults?.().prf ?? null

/**
 * Ask an existing credential for its PRF output. Also the second half of registration on
 * platforms that only evaluate `prf` at assertion time.
 *
 * `allowCredentials` is the list of ids this user has registered, so the platform offers only
 * passkeys that can actually open these lists rather than every passkey on the device. An
 * empty list means "any resident credential for this site", which is what a device that has
 * lost its local record of the ids falls back to.
 */
async function assertPrf(credentialIds = []) {
  let assertion
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomChallenge(),
        rpId: globalThis.location.hostname,
        timeout: TIMEOUT_MS,
        allowCredentials: credentialIds.map((id) => ({
          type: 'public-key',
          id: fromBase64Url(id),
        })),
        userVerification: 'required',
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    })
  } catch (err) {
    throw new PasskeyCancelledError(err)
  }

  const first = prfResults(assertion)?.results?.first
  if (!first) {
    throw new PrfUnsupportedError(
      'That passkey did not return the secret this needs. It may have been created by a ' +
        'browser without PRF support.',
    )
  }

  return { credentialId: toBase64Url(assertion.rawId), prf: new Uint8Array(first) }
}

/**
 * Register a passkey and get its PRF output.
 *
 * Two shapes of platform to survive, both normal:
 *
 *   - PRF evaluated during `create()` — one prompt, the output arrives with the credential.
 *   - PRF only reported as `enabled` — the spec allows this, so the output has to be fetched
 *     with an immediate `get()`, which is a second prompt (§6). Rather than guess which kind
 *     of platform this is, ask for the eval and use the assertion only if it is missing.
 *
 * `residentKey: 'required'` so the credential is discoverable: a device that has lost its
 * local list of credential ids can still be offered the passkey by the platform.
 */
export async function registerPasskey({ userId, userName, displayName }) {
  if (!isPasskeySupported()) throw new PrfUnsupportedError('This browser has no passkey support.')

  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: randomChallenge(),
        timeout: TIMEOUT_MS,
        rp: { name: RP_NAME, id: globalThis.location.hostname },
        user: {
          // Ties the credential to the signed-in account, so registering a second passkey
          // for the same user replaces nothing and adding one for a different account on a
          // shared device does not collide.
          id: encoder.encode(String(userId)),
          name: userName,
          displayName: displayName || userName,
        },
        pubKeyCredParams: ALGORITHMS,
        authenticatorSelection: {
          residentKey: 'required',
          // The fingerprint is the whole point: without user verification the authenticator
          // is allowed to release the PRF output with no check at all.
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    })
  } catch (err) {
    throw new PasskeyCancelledError(err)
  }

  const credentialId = toBase64Url(credential.rawId)
  const prf = prfResults(credential)

  // `enabled: false` — or no `prf` block at all — means this credential will never produce a
  // secret. Say so now: the alternative is a passkey that registers happily and then cannot
  // open anything.
  if (!prf?.enabled && !prf?.results?.first) throw new PrfUnsupportedError()

  if (prf.results?.first) {
    return { credentialId, prf: new Uint8Array(prf.results.first) }
  }

  // Enabled but not evaluated: fetch it, restricted to the credential just made.
  const asserted = await assertPrf([credentialId])
  if (asserted.credentialId !== credentialId) throw new PrfUnsupportedError()

  return asserted
}

/** Unlock: one prompt, one PRF output, from whichever registered passkey the user picks. */
export const passkeyPrf = (credentialIds) => assertPrf(credentialIds)
