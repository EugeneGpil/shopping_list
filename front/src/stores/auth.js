import { defineStore, acceptHMRUpdate } from 'pinia'
import { auth } from 'src/boot/firebase'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { api, TOKEN_KEY } from 'src/api'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    ready: false,
  }),

  getters: {
    isLoggedIn: (state) => !!state.user,
  },

  actions: {
    init() {
      return new Promise((resolve) => {
        onAuthStateChanged(auth, async (firebaseUser) => {
          if (firebaseUser) {
            if (!localStorage.getItem(TOKEN_KEY)) {
              await this._syncWithBackend(firebaseUser)
            }
            this.user = firebaseUser
          } else {
            this.user = null
            localStorage.removeItem(TOKEN_KEY)
          }
          this.ready = true
          resolve(this.user)
        })
      })
    },

    async _syncWithBackend(firebaseUser) {
      const idToken = await firebaseUser.getIdToken()
      const { data: { token } } = await api.post('auth/firebase', { id_token: idToken })
      localStorage.setItem(TOKEN_KEY, token)
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