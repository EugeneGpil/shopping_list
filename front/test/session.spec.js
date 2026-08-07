import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { installLocalStorage } from './fakeServer'

/**
 * What happens when the API token stops working — the case the offline notes called the
 * biggest remaining hole, because the records stayed dirty and the app retried forever
 * without ever telling anyone.
 *
 * Two halves, tested here together because neither is worth much alone: `api.js` trades a
 * 401 for a fresh token and runs the request again, and the auth store decides when that
 * is hopeless and raises the flag the banner reads.
 */

// Firebase has no business in a node test; the store only ever asks these three things of
// it. `signInWithPopup` is handed back per test through `popupUser`.
let popupUser = null
vi.mock('src/boot/firebase', () => ({ auth: {} }))
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {},
  onAuthStateChanged: () => {},
  signOut: async () => {},
  signInWithPopup: async () => {
    if (!popupUser) throw new Error('popup closed')
    return { user: popupUser }
  },
}))

const { useAuthStore } = await import('src/stores/auth')
const { api, TOKEN_KEY } = await import('src/api')

/**
 * An API that only accepts the token it last minted, so a stale one gets the real 401 the
 * backend would send. `auth/firebase` is the one call that works without a token — that is
 * what makes recovery possible.
 */
function fakeApi({ willMint = true } = {}) {
  const state = { calls: [], minted: null, offline: false }
  let seq = 0

  globalThis.fetch = async (url, init = {}) => {
    if (state.offline) throw new TypeError('Failed to fetch')
    const path = new URL(url, 'http://test.local').pathname.replace(/^.*\/api\//, '')
    state.calls.push(`${init.method ?? 'GET'} ${path}`)

    if (path === 'auth/firebase') {
      if (!willMint) return { ok: false, status: 401, json: async () => ({}) }
      state.minted = `token-${++seq}`
      return { ok: true, status: 200, json: async () => ({ data: { token: state.minted } }) }
    }

    const sent = init.headers?.Authorization
    if (!state.minted || sent !== `Bearer ${state.minted}`) {
      return { ok: false, status: 401, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => ({ data: 'ok' }) }
  }

  return state
}

/** A Firebase user, which is only ever asked for an id token. */
const firebaseUser = () => ({ getIdToken: vi.fn(async () => 'id-token') })

function freshStore() {
  setActivePinia(createPinia())
  return useAuthStore()
}

beforeEach(() => {
  installLocalStorage()
  popupUser = null
})

describe('a request that meets a dead token', () => {
  it('mints a new one and goes through, without the caller ever seeing the 401', async () => {
    const server = fakeApi()
    const store = freshStore()
    store.user = firebaseUser()
    localStorage.setItem(TOKEN_KEY, 'stale')

    await expect(api.get('shopping-lists')).resolves.toEqual({ data: 'ok' })
    expect(server.calls).toEqual([
      'GET shopping-lists', // refused
      'POST auth/firebase', // exchanged
      'GET shopping-lists', // and again, with the new token
    ])
    expect(store.sessionExpired).toBe(false)
  })

  it('asks Firebase for a fresh id token rather than its cached one', async () => {
    fakeApi()
    const store = freshStore()
    store.user = firebaseUser()

    await api.get('shopping-lists')
    expect(store.user.getIdToken).toHaveBeenCalledWith(true)
  })

  it('gives up after one exchange, so a refusing backend cannot start a loop', async () => {
    const server = fakeApi({ willMint: false })
    const store = freshStore()
    store.user = firebaseUser()
    localStorage.setItem(TOKEN_KEY, 'stale')

    await expect(api.get('shopping-lists')).rejects.toMatchObject({ status: 401 })
    expect(server.calls).toEqual(['GET shopping-lists', 'POST auth/firebase'])
    expect(store.sessionExpired).toBe(true)
  })

  it('costs one request, not two, once the session is known to be dead', async () => {
    const server = fakeApi({ willMint: false })
    const store = freshStore()
    store.user = firebaseUser()
    await api.get('shopping-lists').catch(() => {})
    server.calls.length = 0

    await api.get('shopping-lists').catch(() => {})
    expect(server.calls).toEqual(['GET shopping-lists'])
  })
})

describe('recovering the session', () => {
  it('exchanges once for callers that all fail at the same moment', async () => {
    const server = fakeApi()
    const store = freshStore()
    store.user = firebaseUser()

    await Promise.all([store.recoverSession(), store.recoverSession(), store.recoverSession()])
    expect(server.calls.filter((c) => c.endsWith('auth/firebase'))).toHaveLength(1)
  })

  it('drops the dead token, so the next sign-in is not stuck with it', async () => {
    fakeApi({ willMint: false })
    const store = freshStore()
    store.user = firebaseUser()
    localStorage.setItem(TOKEN_KEY, 'stale')

    await store.recoverSession()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('does not blame the session for a lost connection', async () => {
    const server = fakeApi()
    const store = freshStore()
    store.user = firebaseUser()
    localStorage.setItem(TOKEN_KEY, 'stale')
    server.offline = true

    expect(await store.recoverSession()).toBe(false)
    // Nothing to sign in for: the token may well be fine, we just could not reach anyone.
    expect(store.sessionExpired).toBe(false)
    expect(localStorage.getItem(TOKEN_KEY)).toBe('stale')
  })

  it('has nothing to recover from without a Firebase session', async () => {
    const server = fakeApi()
    const store = freshStore()

    expect(await store.recoverSession()).toBe(false)
    expect(server.calls).toEqual([])
  })
})

describe('signing in again from the banner', () => {
  it('clears the flag and mints a token, since Firebase reports no change of user', async () => {
    fakeApi()
    const store = freshStore()
    store.user = firebaseUser()
    store.sessionExpired = true
    popupUser = firebaseUser()

    expect(await store.signInAgain()).toBe(true)
    expect(store.sessionExpired).toBe(false)
    expect(localStorage.getItem(TOKEN_KEY)).toBe('token-1')
  })

  it('leaves the banner up when the popup is closed', async () => {
    fakeApi()
    const store = freshStore()
    store.user = firebaseUser()
    store.sessionExpired = true

    expect(await store.signInAgain()).toBe(false)
    expect(store.sessionExpired).toBe(true)
  })
})
