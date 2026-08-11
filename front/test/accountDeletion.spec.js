import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { installLocalStorage } from './fakeServer'

/**
 * Deleting the account — the client half of `DELETE /api/account`.
 *
 * The request itself is the trivial part. What is pinned here is the teardown around it,
 * because both halves of it are traps that fail *silently* and in opposite directions:
 *
 *   - Signing out through `logout()` sends a request with a token the server has just
 *     deleted. `api.js` treats any 401 as an expired session, trades the still-valid
 *     Firebase session for a new one, and `auth/firebase` is an `updateOrCreate` — so the
 *     account comes straight back, empty. The person is left signed in to an account they
 *     just deleted.
 *   - Clearing the per-user caches after the session has ended clears the wrong ones. They
 *     are keyed by `user.uid`, and by then there is no user, so the deleted account's lists
 *     stay in localStorage on a device whose owner was told they were gone.
 *
 * Neither shows up as an error anywhere. Hence a test each.
 */

vi.mock('src/boot/firebase', () => ({ auth: {} }))
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {},
  onAuthStateChanged: () => {},
  signOut: async () => {},
  signInWithPopup: async () => {
    throw new Error('not used here')
  },
}))

const { useAuthStore } = await import('src/stores/auth')
const { TOKEN_KEY } = await import('src/api')

/**
 * A server that accepts only the token it minted, so a request made with a deleted one gets
 * the real 401 — which is what makes the resurrection path reachable rather than theoretical.
 */
function fakeApi({ deletionFails = false } = {}) {
  const state = { calls: [], token: 'token-1', deleted: false }

  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, 'http://test.local').pathname.replace(/^.*\/api\//, '')
    const method = init.method ?? 'GET'
    state.calls.push(`${method} ${path}`)

    if (path === 'auth/firebase') {
      // Exactly what the real endpoint does: `updateOrCreate`, so this both mints a token
      // and puts the user back if they were gone.
      state.deleted = false
      state.token = 'token-2'
      return { ok: true, status: 200, json: async () => ({ data: { token: state.token } }) }
    }

    if (state.deleted || init.headers?.Authorization !== `Bearer ${state.token}`) {
      return { ok: false, status: 401, json: async () => ({}) }
    }

    if (path === 'account' && method === 'DELETE') {
      if (deletionFails) return { ok: false, status: 500, json: async () => ({}) }
      state.deleted = true
      return { ok: true, status: 200, json: async () => ({ data: null }) }
    }

    return { ok: true, status: 200, json: async () => ({ data: 'ok' }) }
  }

  return state
}

function signedInStore() {
  setActivePinia(createPinia())
  const store = useAuthStore()
  store.user = { uid: 'user-1', getIdToken: vi.fn(async () => 'id-token') }
  localStorage.setItem(TOKEN_KEY, 'token-1')
  return store
}

let storage

beforeEach(() => {
  storage = installLocalStorage()
})

describe('deleting the account', () => {
  it('sends one authenticated DELETE and nothing else', async () => {
    const server = fakeApi()
    const store = signedInStore()

    await store.deleteAccount()

    expect(server.calls).toEqual(['DELETE account'])
    expect(server.deleted).toBe(true)
  })

  it('ends the session without a request, so the account cannot come back', async () => {
    const server = fakeApi()
    const store = signedInStore()

    await store.deleteAccount()
    await store.endSession()

    // The absence of `POST auth/firebase` is the whole point: `logout()` here would have
    // produced a 401, an exchange, and a live account again.
    expect(server.calls).toEqual(['DELETE account'])
    expect(server.deleted).toBe(true)
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(store.user).toBeNull()
  })

  it('resurrects the account if the session is ended the ordinary way — the reason it is not', async () => {
    const server = fakeApi()
    const store = signedInStore()

    await store.deleteAccount()
    await store.logout()

    expect(server.calls).toEqual([
      'DELETE account',
      'POST auth/logout', // refused, the token is gone with the account
      'POST auth/firebase', // and this is the damage: updateOrCreate
      'POST auth/logout',
    ])
    expect(server.deleted).toBe(false)
  })

  it('leaves the session usable when the server refuses', async () => {
    fakeApi({ deletionFails: true })
    const store = signedInStore()

    await expect(store.deleteAccount()).rejects.toMatchObject({ status: 500 })

    // Nothing local was touched, so the failure is recoverable by pressing the button again.
    expect(localStorage.getItem(TOKEN_KEY)).toBe('token-1')
    expect(store.user).not.toBeNull()
  })

  it('leaves the session usable when the request never reaches the server', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    const store = signedInStore()

    await expect(store.deleteAccount()).rejects.toBeInstanceOf(TypeError)
    expect(localStorage.getItem(TOKEN_KEY)).toBe('token-1')
    expect(store.user).not.toBeNull()
  })
})

describe('the local copy of the lists', () => {
  /**
   * The cache key is built from the signed-in user, so "clear the cache" and "forget who is
   * signed in" are not commutative. The page does them in this order for that reason; this
   * pins the order rather than the page.
   */
  const CACHE_KEY = 'shopping_lists:v1:user-1'

  it('is gone when cleared before the session ends', async () => {
    fakeApi()
    const store = signedInStore()
    storage.set(CACHE_KEY, JSON.stringify({ lists: [], orderDirty: false }))

    await store.deleteAccount()
    localStorage.removeItem(`shopping_lists:v1:${store.user.uid}`)
    await store.endSession()

    expect(storage.has(CACHE_KEY)).toBe(false)
  })

  it('survives on the device when cleared after — which is the bug being avoided', async () => {
    fakeApi()
    const store = signedInStore()
    storage.set(CACHE_KEY, JSON.stringify({ lists: [], orderDirty: false }))

    await store.deleteAccount()
    await store.endSession()
    // What the lists store computes once `user` is null: `${KEY}:anon`.
    localStorage.removeItem(`shopping_lists:v1:${store.user?.uid ?? 'anon'}`)

    expect(storage.has(CACHE_KEY)).toBe(true)
  })
})
