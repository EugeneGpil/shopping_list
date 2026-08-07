const BASE = import.meta.env.VITE_API_URL

export const TOKEN_KEY = 'sanctum_token'

/** The one call that must never trigger a recovery attempt: it *is* the recovery. */
const AUTH_EXCHANGE = 'auth/firebase'

function send(method, path, body) {
  const token = localStorage.getItem(TOKEN_KEY)
  return fetch(`${BASE}/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/**
 * `mayRecover` is false on the second attempt, so a 401 can cost at most one extra
 * exchange — never a loop.
 */
async function request(method, path, body, mayRecover = true) {
  let res = await send(method, path, body)

  // A 401 here is about the API token, not the person: it is minted from a Firebase
  // session that usually outlives it, and it dies in ordinary ways — pruned after 90 idle
  // days, or never exchanged at all because the app booted with no connection. So trade
  // the Firebase session for a fresh one and run the request again before anyone is
  // bothered about it. `recoverSession` decides when that is hopeless and says so once.
  if (res.status === 401 && mayRecover && path !== AUTH_EXCHANGE) {
    // Imported here, not at the top: the auth store imports this module, and only the
    // rare 401 path needs it.
    const { useAuthStore } = await import('src/stores/auth')
    if (await useAuthStore().recoverSession()) {
      res = await send(method, path, body)
    }
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    // Some failures carry a body worth having: a 409 answers with the copy that won, so
    // the caller can adopt it without a second request. An error page that is not JSON
    // must not mask the status, hence the swallow.
    err.body = await res.json().catch(() => null)
    throw err
  }
  return res.json()
}

// Distinguishes "we never reached the server" from "the server answered and said no".
// `request` above attaches `status` only when a response came back, `fetch` rejects with a
// TypeError when the transport fails, and Firebase uses its own code for the same case.
export function isNetworkError(err) {
  if (!err) return false
  if (err.code === 'auth/network-request-failed') return true
  if (err.status !== undefined) return false
  return err instanceof TypeError || !navigator.onLine
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
}
