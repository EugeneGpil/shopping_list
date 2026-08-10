import { describe, expect, it } from 'vitest'
import { dismissInstallHint, shouldOfferInstallHint } from 'src/utils/installHint'

/**
 * The hint exists for one platform and must stay out of the way everywhere else, so what is
 * worth pinning is the decision rather than the markup: an iPhone that has not installed the
 * app yet, and nothing else.
 *
 * Every dependency is passed in — that is why the module takes them as arguments — so these
 * are plain function calls with no browser and no component involved.
 */

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36'

const browser = () => ({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })
const inSafari = () => undefined
const asHomeScreenApp = () => ({ matches: true })

/** Just enough of localStorage to be written to and read back, or to refuse both. */
function fakeStorage(refuse = false) {
  const values = {}
  if (refuse) {
    return {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
  }
  return {
    getItem: (k) => values[k] ?? null,
    setItem: (k, v) => {
      values[k] = v
    },
  }
}

describe('offering the iOS install hint', () => {
  it('offers it on an iPhone in Safari', () => {
    expect(shouldOfferInstallHint(browser(), inSafari, fakeStorage())).toBe(true)
  })

  it('offers it on an iPad, which claims to be a Mac', () => {
    const ipad = { userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 5 }
    expect(shouldOfferInstallHint(ipad, inSafari, fakeStorage())).toBe(true)
  })

  it('leaves a real Mac alone — same user agent, no touch', () => {
    const mac = { userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 0 }
    expect(shouldOfferInstallHint(mac, inSafari, fakeStorage())).toBe(false)
  })

  it('says nothing on Android, where the browser prompts by itself', () => {
    const android = { userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 }
    expect(shouldOfferInstallHint(android, inSafari, fakeStorage())).toBe(false)
  })

  it('says nothing once the app has been installed — Apple’s own flag', () => {
    expect(
      shouldOfferInstallHint({ ...browser(), standalone: true }, inSafari, fakeStorage()),
    ).toBe(false)
  })

  it('says nothing once the app has been installed — the standard display mode', () => {
    expect(shouldOfferInstallHint(browser(), asHomeScreenApp, fakeStorage())).toBe(false)
  })

  it('does not come back after it has been dismissed', () => {
    const storage = fakeStorage()
    expect(shouldOfferInstallHint(browser(), inSafari, storage)).toBe(true)
    dismissInstallHint(storage)
    expect(shouldOfferInstallHint(browser(), inSafari, storage)).toBe(false)
  })

  it('still offers it when storage is denied outright, rather than failing', () => {
    const denied = fakeStorage(true)
    expect(shouldOfferInstallHint(browser(), inSafari, denied)).toBe(true)
    expect(() => dismissInstallHint(denied)).not.toThrow()
  })
})
