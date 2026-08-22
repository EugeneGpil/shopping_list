import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PasskeyCancelledError, passkeyPrf, registerPasskey } from 'src/utils/passkey'

/**
 * The options handed to WebAuthn, and what comes back out of a refusal.
 *
 * `passkey.js` is plain JS with one dependency — `navigator.credentials` — so this suite stubs
 * that and reads the request it was given. There is no assertion to verify and no server
 * involved (see the module's own note), so what is worth pinning is the shape of the ask: the
 * only part of the call this app controls.
 *
 * The timeout is here because its absence had no visible symptom until an authenticator was
 * taken away: `create()` and `get()` are allowed to wait forever, so with nothing to answer
 * them the unlock button spun past 30 seconds with no message and then unspun when a device
 * appeared. A missing optional field is exactly the kind of thing only a test notices.
 */
describe('the passkey request', () => {
  let asked
  const previous = { credentials: navigator?.credentials, location: globalThis.location }

  /** A credential that answers with a PRF output, as a platform evaluating `prf` at create. */
  const credential = {
    rawId: new Uint8Array([1, 2, 3]),
    getClientExtensionResults: () => ({
      prf: { enabled: true, results: { first: new Uint8Array(32) } },
    }),
  }

  const install = (answer) => {
    const record = (options) => {
      asked.push(options.publicKey)
      return answer()
    }
    globalThis.navigator ??= {}
    globalThis.navigator.credentials = { create: record, get: record }
    globalThis.PublicKeyCredential = class {}
    globalThis.location = { hostname: 'lists.test' }
  }

  beforeEach(() => {
    asked = []
    install(async () => credential)
  })

  afterEach(() => {
    if (previous.credentials) navigator.credentials = previous.credentials
    globalThis.location = previous.location
    delete globalThis.PublicKeyCredential
  })

  // See `TIMEOUT_MS` for why 60s, and why not shorter.
  const TIMEOUT = 60_000

  it('bounds an unlock, so a prompt nothing answers ends', async () => {
    await passkeyPrf(['AQID'])

    expect(asked[0].timeout).toBe(TIMEOUT)
  })

  it('bounds registration the same way', async () => {
    await registerPasskey({ userId: 'u1', userName: 'a@example.test' })

    expect(asked[0].timeout).toBe(TIMEOUT)
  })

  it('reports the expiry as a message, and says what it cannot tell apart', async () => {
    // What the platform sends for a dismissed prompt, an unusable device and an expired
    // timeout alike — deliberately, since telling a page which one happened is itself a leak.
    install(async () => {
      throw Object.assign(new Error('The operation either timed out or was not allowed.'), {
        name: 'NotAllowedError',
      })
    })

    const err = await passkeyPrf([]).catch((e) => e)

    // The spinner is bounded by the timeout above; this is what has to be on screen when it
    // ends. Naming the third case is the honest option — the other two are equally possible.
    expect(err).toBeInstanceOf(PasskeyCancelledError)
    expect(err.message).toMatch(/in time/)
  })
})
