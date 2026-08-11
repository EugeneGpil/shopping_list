import { defineStore, acceptHMRUpdate } from 'pinia'
import { auth } from 'src/boot/firebase'
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { api, TOKEN_KEY, isNetworkError } from 'src/api'

// The in-flight recovery, shared by every caller. A dead token makes every request in a
// sync pass fail at once, and they must produce one exchange between them, not one each.
let recovering = null

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    ready: false,
    // Signed in to Firebase but with no sanctum token yet, because the exchange failed offline.
    syncPending: false,
    // The backend refused our token and would not mint a new one from the Firebase session
    // either. Nothing local is lost — edits stay queued — but only the user can fix it, so
    // this is what puts the "sign in again" banner up.
    sessionExpired: false,
  }),

  getters: {
    isLoggedIn: (state) => !!state.user,
  },

  actions: {
    init() {
      return new Promise((resolve) => {
        onAuthStateChanged(auth, async (firebaseUser) => {
          try {
            if (firebaseUser) {
              // Set before the await: if the sync below fails we still know who is signed in.
              this.user = firebaseUser
              if (!localStorage.getItem(TOKEN_KEY)) {
                await this._syncWithBackend(firebaseUser)
              }
            } else {
              this.user = null
              localStorage.removeItem(TOKEN_KEY)
            }
          } catch (err) {
            if (isNetworkError(err)) {
              // Offline with a persisted Firebase session: stay signed in locally and get the
              // sanctum token once we are back online.
              this.syncPending = true
            } else {
              // The backend answered and refused this identity — don't pretend we are signed in.
              this.user = null
              localStorage.removeItem(TOKEN_KEY)
            }
          } finally {
            // Must always run. `boot/firebase.js` awaits this promise, so leaving it unsettled
            // means the app never mounts at all — a blank page with no error.
            this.ready = true
            resolve(this.user)
          }
        })
      })
    },

    /**
     * Retry the exchange that was skipped offline.
     *
     * Safe and cheap to call at any time — it returns at once unless a Firebase session
     * is sitting there without a sanctum token. That is why the read paths in the lists
     * store simply call it before every fetch instead of trying to work out for
     * themselves whether the app has credentials yet.
     */
    async retrySync() {
      if (!this.syncPending || !this.user) return
      if (localStorage.getItem(TOKEN_KEY)) {
        this.syncPending = false
        return
      }
      try {
        await this._syncWithBackend(this.user)
        this.syncPending = false
      } catch (err) {
        // Still offline: leave the flag up so the next attempt retries. Anything else is a
        // definitive refusal, so stop retrying.
        //
        // Deliberately unlike `init()`, a refusal here does NOT clear `user`. This runs
        // mid-session, when unsynced local edits may exist, and dropping the session would
        // discard them — the user keeps working locally and re-auth is surfaced by the UI.
        if (!isNetworkError(err)) this.syncPending = false
      }
    },

    /**
     * Mint a fresh API token from the Firebase session, after the backend refused the one
     * we were using. Returns whether we hold a working token now.
     *
     * Called from `api.js` on any 401, so it has to be cheap to call and safe to call from
     * several places at once: already-known-dead returns without a request, and concurrent
     * callers share one exchange.
     */
    async recoverSession() {
      // No point asking again — the banner is up, and only the user can act on it now.
      // This is what keeps a failing save to one failed request rather than two.
      if (this.sessionExpired || !this.user) return false
      if (!recovering) {
        recovering = this._recoverOnce().finally(() => {
          recovering = null
        })
      }
      return recovering
    },

    async _recoverOnce() {
      try {
        await this._syncWithBackend(this.user, true)
        return true
      } catch (err) {
        // Offline says nothing about the session. Leave the flags alone and let the
        // caller's own offline handling deal with it, or a re-login would be demanded of
        // someone whose only problem is a tunnel.
        if (isNetworkError(err)) return false
        // A definitive refusal. Drop the dead token as well as raising the flag: `init()`
        // only exchanges when there is none, so keeping it would stop the next sign-in
        // from ever getting a working one.
        localStorage.removeItem(TOKEN_KEY)
        this.sessionExpired = true
        return false
      }
    },

    /** Opens Google's popup. Resolves to the user, or null if they closed it. */
    async loginWithGoogle() {
      const provider = new GoogleAuthProvider()
      return signInWithPopup(auth, provider)
        .then(({ user }) => user)
        .catch(() => null)
    },

    /**
     * What the expired-session banner does: re-authenticate, then immediately trade that
     * for an API token, because `onAuthStateChanged` does not fire when the same user
     * signs in again — so nothing else would.
     */
    async signInAgain() {
      const user = await this.loginWithGoogle()
      if (!user) return false
      this.user = user
      // Lowered first, or `recoverSession` would decline to try.
      this.sessionExpired = false
      return this.recoverSession()
    },

    async _syncWithBackend(firebaseUser, forceFresh = false) {
      // `true` re-reads the token from Firebase instead of using its cached copy, which is
      // the point when we are here because the backend just rejected what we had.
      const idToken = await firebaseUser.getIdToken(forceFresh)
      const {
        data: { token },
      } = await api.post('auth/firebase', { id_token: idToken })
      localStorage.setItem(TOKEN_KEY, token)
      // The only place a token is minted, so the only place both flags can be cleared.
      this.syncPending = false
      this.sessionExpired = false
    },

    async logout() {
      await api.post('auth/logout').catch(() => {})
      await this.endSession()
    },

    /**
     * Everything a sign-out does on this device, with nothing said to the server.
     *
     * Split out of `logout` for the one caller that must not talk to the server: after the
     * account is deleted there is no token left to revoke, and asking anyway is actively
     * harmful (see `deleteAccount`).
     */
    async endSession() {
      localStorage.removeItem(TOKEN_KEY)
      await signOut(auth)
      this.user = null
      this.sessionExpired = false
    },

    /**
     * Delete the account and everything on it. Throws if the server refuses, and touches
     * nothing locally either way, so a failure leaves the session exactly as it was.
     *
     * The caller does the teardown, and both halves of how matter:
     *
     * 1. Clear the per-user caches **first**. They are keyed by `user.uid`, which this store
     *    is about to forget — clear them after and the key resolves to `anon`, leaving the
     *    deleted account's lists sitting in localStorage.
     * 2. Then `endSession()`, never `logout()`. `logout` POSTs with a token the server has
     *    just deleted; the 401 interceptor in `api.js` reads that as an expired session and
     *    trades the still-valid Firebase session for a fresh one — and `auth/firebase`
     *    is an `updateOrCreate`, so it would put the account straight back, empty.
     */
    async deleteAccount() {
      await api.del('account')
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAuthStore, import.meta.hot))
}
