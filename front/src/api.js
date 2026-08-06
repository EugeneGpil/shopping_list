const BASE = import.meta.env.VITE_API_URL

export const TOKEN_KEY = 'sanctum_token'

async function request(method, path, body) {
  const token = localStorage.getItem(TOKEN_KEY)
  const res = await fetch(`${BASE}/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
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
