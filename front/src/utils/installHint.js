/**
 * Whether to tell this browser how to install the app by hand.
 *
 * Everywhere else the browser does this itself: Chrome fires `beforeinstallprompt` and draws
 * its own install UI (which is what the manifest `screenshots` feed). iOS has no such event
 * and no prompt at all — the only way in is Share → "Add to Home Screen", which is invisible
 * unless somebody says so. So this is deliberately *not* a general "install this app" banner:
 * it is one line for the one platform that cannot offer one.
 *
 * The dependencies are arguments rather than globals so the decision can be tested without a
 * browser; nothing in the app passes them.
 */

const KEY = 'install_hint:v1:dismissed'

/**
 * An iPhone or iPad.
 *
 * `platform` is deprecated but still reported everywhere, and it is the only cheap way to
 * catch iPadOS 13+, which sends a desktop Safari user agent — the touch points are what give
 * an iPad away. A Mac with a touch bar does not report touch points, so this does not catch
 * one by mistake.
 */
const isIos = (nav) =>
  /iPad|iPhone|iPod/.test(nav.userAgent ?? '') ||
  (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)

/**
 * Already installed, so there is nothing to explain.
 *
 * Both checks are needed: `navigator.standalone` is Apple's own flag and the only signal in
 * older iOS versions, while `display-mode` is the standard one and what a home screen app
 * reports from iOS 16.4 on.
 */
const isInstalled = (nav, matchMedia) =>
  nav.standalone === true || matchMedia?.('(display-mode: standalone)')?.matches === true

/** Read as "we already said this once". Dismissal is per browser, not per account: it is
 *  about this device's home screen, and it outlives whoever is signed in. */
function dismissed(storage) {
  try {
    return storage?.getItem(KEY) === '1'
  } catch {
    // Private mode can refuse storage outright. Showing the hint is the safe side of that:
    // the worst case is one dismissible line seen twice.
    return false
  }
}

export function shouldOfferInstallHint(
  nav = navigator,
  matchMedia = typeof window === 'undefined' ? undefined : window.matchMedia?.bind(window),
  storage = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  return isIos(nav) && !isInstalled(nav, matchMedia) && !dismissed(storage)
}

export function dismissInstallHint(
  storage = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  try {
    storage?.setItem(KEY, '1')
  } catch {
    // Refused, so the hint comes back next time. Not worth handling further — it is a hint.
  }
}
