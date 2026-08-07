import { describe, expect, it, vi } from 'vitest'

/**
 * The global handler's job is to tell the two kinds of failure apart: a server that
 * answered and said no, which is worth a red alert, and a connection that was not there,
 * which this app expects and handles — so it gets one calm line per disconnection however
 * many requests fell over.
 *
 * The listeners it registers are the seam: install it against a fake `window`, keep the
 * handlers, and hand them rejections.
 */
async function install() {
  const handlers = {}
  vi.stubGlobal('window', {
    addEventListener: (type, fn) => {
      handlers[type] = fn
    },
  })
  // Fresh modules per install: the "already reported" flag lives at module scope, which is
  // the very thing under test. The Notify stub is re-imported here for the same reason —
  // after a reset the handler writes into a new instance of it, not the one this file
  // imported at load time.
  vi.resetModules()
  const { notifications } = await import('./stubs/quasar')
  const { default: register } = await import('src/boot/error-handler')
  register({})
  return {
    notifications,
    reject: (reason) => handlers.unhandledrejection({ reason }),
    reconnect: () => handlers.online(),
  }
}

// `isNetworkError` reads `navigator.onLine` only for errors that are neither a TypeError
// nor carrying a status, and node has no such flag — so every case here is one or the
// other, which is also what the app actually throws.
const transportFailure = () => new TypeError('Failed to fetch')
const serverSaidNo = (status) => Object.assign(new Error(`HTTP ${status}`), { status })

describe('the global error handler', () => {
  it('reports a lost connection once, not once per failed request', async () => {
    const app = await install()
    app.reject(transportFailure())
    app.reject(transportFailure())
    app.reject(transportFailure())
    expect(app.notifications).toHaveLength(1)
  })

  it('says it calmly, and says nothing was lost', async () => {
    const app = await install()
    app.reject(transportFailure())
    expect(app.notifications[0].color).toBe('grey-8')
    expect(app.notifications[0].type).toBeUndefined() // never `negative` for this
    expect(app.notifications[0].message).toMatch(/offline/i)
    expect(app.notifications[0].message).toMatch(/saved on this device/i)
  })

  it('speaks up again about the next disconnection, once reconnected', async () => {
    const app = await install()
    app.reject(transportFailure())
    app.reconnect()
    app.reject(transportFailure())
    expect(app.notifications).toHaveLength(2)
  })

  it('still raises a red alert when the server answered and refused', async () => {
    const app = await install()
    app.reject(serverSaidNo(403))
    expect(app.notifications).toEqual([
      { type: 'negative', message: "You don't have permission to do that" },
    ])
  })

  it('does not let a refusal silence the offline notice, or the other way round', async () => {
    const app = await install()
    app.reject(serverSaidNo(500))
    app.reject(transportFailure())
    app.reject(serverSaidNo(500))
    expect(app.notifications.map((n) => n.type)).toEqual(['negative', undefined, 'negative'])
  })
})
