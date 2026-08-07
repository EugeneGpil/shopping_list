import { boot } from 'quasar/wrappers'
import { Notify } from 'quasar'
import { isNetworkError } from 'src/api'

/**
 * The last-resort handler for promise rejections nothing else caught.
 *
 * Losing the connection is not one of the things it shouts about. Offline is a state this
 * app is built for — edits land locally and `sync.js` pushes them when it can — and a
 * dropped connection breaks every request in flight at once, so the honest report is one
 * calm line, once, rather than a red "Failed to fetch" per call.
 */

// Raised on the first transport failure and lowered when the browser sees a connection
// again, so each disconnection is announced exactly once and the next one is announced
// afresh. Module scope, not the boot closure, so it survives a hot reload of this file.
let offlineReported = false

export default boot(() => {
  window.addEventListener('online', () => {
    offlineReported = false
  })

  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason

    // `isNetworkError` is the app's single definition of "we never reached the server" —
    // the same one the store uses to decide between showing cached data and giving up.
    if (isNetworkError(err)) {
      if (offlineReported) return
      offlineReported = true
      Notify.create({
        // Deliberately not `negative`: nothing has been lost, so a red alert would be
        // both wrong and, on a phone in a shop, alarming.
        color: 'grey-8',
        textColor: 'white',
        icon: 'cloud_off',
        timeout: 4000,
        message: 'You are offline. Changes are saved on this device and will sync later.',
      })
      return
    }

    const status = err?.status
    const message =
      status === 401
        ? 'Session expired, please log in again'
        : status === 403
          ? "You don't have permission to do that"
          : status === 404
            ? 'Resource not found'
            : status >= 500
              ? 'Server error, try again later'
              : err?.message || 'Something went wrong'

    Notify.create({ type: 'negative', message })
  })
})
