import { defineStore, acceptHMRUpdate } from 'pinia'
import { auth } from 'src/boot/firebase'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { api, TOKEN_KEY, isNetworkError } from 'src/api'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    ready: false,
    // Signed in to Firebase but with no sanctum token yet, because the exchange failed offline.
    syncPending: false,
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

    // Retry the exchange that was skipped offline. Safe to call at any time.
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

    async _syncWithBackend(firebaseUser) {
      const idToken = await firebaseUser.getIdToken()
      const {
        data: { token },
      } = await api.post('auth/firebase', { id_token: idToken })
      localStorage.setItem(TOKEN_KEY, token)
      this.syncPending = false
    },

    async logout() {
      await api.post('auth/logout').catch(() => {})
      localStorage.removeItem(TOKEN_KEY)
      await signOut(auth)
      this.user = null
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAuthStore, import.meta.hot))
}
