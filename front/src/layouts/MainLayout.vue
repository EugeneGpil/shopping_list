<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container>
      <SessionExpiredBanner />
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script>
import SessionExpiredBanner from 'src/components/SessionExpiredBanner.vue'
import retryWhenOnline from 'src/mixins/retryWhenOnline'
import { useAuthStore } from 'src/stores/auth'
import { useEncryptionStore } from 'src/stores/encryption'
import { useShoppingListsStore } from 'src/stores/shoppingLists'

export default {
  name: 'MainLayout',

  components: { SessionExpiredBanner },

  mixins: [retryWhenOnline],

  computed: {
    // Both pages live inside this layout, so the sync triggers belong here: whatever the user
    // is looking at, pending changes get their chance.
    store() {
      return useShoppingListsStore()
    },

    authStore() {
      return useAuthStore()
    },
  },

  watch: {
    // Credentials coming back: a queue that stalled on a dead token has no other reason to
    // move again, so a recovered session is its own sync trigger.
    'authStore.sessionExpired'(expired, wasExpired) {
      if (wasExpired && !expired) this.store.sync()
    },
  },

  mounted() {
    // Whether this account has an encryption key, asked once. Nothing waits on it: the index and
    // every unencrypted list work with no key at all, and it is only needed the moment a locked
    // list is opened — by which time it has long arrived.
    useEncryptionStore().load()

    // On launch, because a previous session may have been killed with changes still queued —
    // `sync()` is a no-op when there is nothing to send.
    this.store.sync()

    document.addEventListener('visibilitychange', this.onVisible)
  },

  beforeUnmount() {
    document.removeEventListener('visibilitychange', this.onVisible)
  },

  methods: {
    // The event that fires the moment a connection comes back.
    retryWhenOnline() {
      this.store.sync()
    },

    // And the one that covers the case `online` misses, which is the actual use case here: the
    // phone was put away in the shop with no signal, found wifi at home while the PWA was
    // suspended, and is opened again later. No `online` event was delivered to a suspended
    // page, so without this the queue would sit there until a reload.
    onVisible() {
      if (document.visibilityState === 'visible') this.store.sync()
    },
  },
}
</script>
