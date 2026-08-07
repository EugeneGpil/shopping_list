import { forStorage, fromStorage } from './record'

// Bump when the record shape changes in a way old data cannot satisfy — a stale key is
// simply never read again, which is cheaper than migrating a shopping list.
const KEY = 'shopping_lists:v1'

// Scoped per user: localStorage outlives a logout, and the next person to sign in on this
// browser must not find someone else's lists sitting there.
const keyFor = (uid) => `${KEY}:${uid || 'anon'}`

/**
 * Call `handler` when *another* tab writes this user's state.
 *
 * The `storage` event is the right signal rather than a `BroadcastChannel`: it fires only
 * in the tabs that did not write, which is exactly the audience, and it cannot report a
 * change that is not on disk — the message and the source of truth are the same thing.
 *
 * `getUid` is read at event time, not now, because a tab can change user without reloading.
 */
export function onExternalWrite(getUid, handler) {
  if (typeof window === 'undefined') return
  window.addEventListener('storage', (event) => {
    // A null `newValue` is the key being removed — another tab logging out. Firebase tells
    // this tab about that itself, and clearing on a bare storage event would race with it.
    if (event.key === keyFor(getUid()) && event.newValue) handler()
  })
}

/**
 * localStorage rather than IndexedDB, which `docs/go_offline.md` originally proposed. The
 * whole payload is a few KB of JSON for a personal shopping list, so the async store buys
 * nothing here; writes are debounced because localStorage is synchronous.
 */
export function readState(uid) {
  try {
    const raw = localStorage.getItem(keyFor(uid))
    if (!raw) return null
    const state = JSON.parse(raw)
    return { lists: fromStorage(state.lists ?? []), orderDirty: !!state.orderDirty }
  } catch {
    // Corrupt, or storage denied outright (Safari private mode throws on read). Starting
    // empty is always safe: the server is still the source of truth.
    return null
  }
}

export function writeState(uid, { lists, orderDirty }) {
  try {
    localStorage.setItem(keyFor(uid), JSON.stringify({ lists: forStorage(lists), orderDirty }))
  } catch {
    // Quota exceeded, or storage denied. The app keeps working; it just forgets on reload.
  }
}

export function clearState(uid) {
  try {
    localStorage.removeItem(keyFor(uid))
  } catch {
    // Nothing to do — if we cannot remove it we also could not have written it.
  }
}
