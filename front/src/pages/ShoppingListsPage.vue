<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <q-form class="row items-center q-gutter-sm q-mb-lg" @submit.prevent="create">
      <q-input
        v-model="newName"
        outlined
        dense
        autogrow
        class="col"
        placeholder="New list name"
        maxlength="255"
        @keydown.enter.prevent="create"
      />
      <q-btn
        type="submit"
        color="primary"
        icon="add"
        label="Create"
        :disable="!newName.trim() || creating"
        :loading="creating"
        unelevated
      />
      <q-btn flat round icon="more_vert">
        <q-menu auto-close>
          <q-list style="min-width: 200px">
            <q-item clickable @click="importing = true">
              <q-item-section avatar><q-icon name="download" /></q-item-section>
              <q-item-section>Import from Google Keep</q-item-section>
            </q-item>
            <q-item clickable @click="encrypting = true">
              <q-item-section avatar><q-icon name="key" /></q-item-section>
              <q-item-section>
                {{ encryption.enabled ? 'Encryption key' : 'Set up encryption' }}
              </q-item-section>
            </q-item>
            <!-- Above the separator with the other everyday things: the trash is somewhere to
                 go and look, not one of the two account actions below the line. -->
            <q-item clickable @click="$router.push('/trash')">
              <q-item-section avatar><q-icon name="delete_outline" /></q-item-section>
              <q-item-section>Trash</q-item-section>
            </q-item>
            <q-separator />
            <q-item clickable @click="onLogout">
              <q-item-section avatar><q-icon name="logout" /></q-item-section>
              <q-item-section>Log out</q-item-section>
            </q-item>
            <!-- Last, separated, and the only red thing in the menu: it is one tap from the
                 same place as "Log out" and does something nothing can undo. -->
            <q-item clickable @click="onDeleteAccount">
              <q-item-section avatar>
                <q-icon name="delete_forever" color="negative" />
              </q-item-section>
              <q-item-section class="text-negative">Delete account</q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn>
    </q-form>

    <ImportFromKeepDialog v-model="importing" />
    <EncryptionDialog v-model="encrypting" />

    <!-- Only when there is nothing to cover. The lists are cached and rendered on the first
         frame, and `load()` runs on every arrival here — including coming back from a list —
         so an unconditional overlay hid the correct lists behind a spinner for as long as the
         index request took. With something on screen the refresh is a background job, and
         `StaleDataNotice` below is what speaks up if it fails. -->
    <q-inner-loading :showing="loading && !store.visibleLists.length" />

    <!-- The two directions, and they are independent: this one is what we may not have
         heard from the server, the one below is what the server has not heard from us. -->
    <StaleDataNotice />

    <!-- Changes are kept locally and pushed when there is a connection, so the only thing
         worth saying is that some are still waiting. Silence would read as "saved". -->
    <div v-if="store.pendingCount" class="row items-center q-gutter-xs q-mb-sm text-grey">
      <q-spinner v-if="store.syncing" size="14px" />
      <q-icon v-else name="cloud_off" size="16px" />
      <span class="text-caption">
        {{ store.syncing ? 'Syncing…' : `${store.pendingCount} change(s) waiting to sync` }}
      </span>
    </div>

    <!-- Last of the three, and the only one that is not about the data: on iOS nothing offers
         to install the app, so this page does. Shows on nothing but an iPhone or iPad that
         has not installed it yet, and only until it is dismissed. It sits here rather than on
         the login screen because installing is worth doing once the app has proved useful,
         and here is where that happens. -->
    <InstallHint />

    <!-- Only reachable with nothing cached to fall back on: with lists in the store they
         are shown instead, stale at worst. -->
    <div v-if="loadFailed && !store.visibleLists.length" class="text-center q-mt-xl">
      <q-icon name="cloud_off" size="48px" color="grey-6" />
      <div class="text-subtitle1 q-mt-sm">Can't load your lists</div>
      <q-btn
        outline
        no-caps
        color="primary"
        label="Retry"
        class="q-mt-md"
        :loading="loading"
        @click="load"
      />
    </div>

    <div v-else-if="!loading && !store.visibleLists.length" class="text-grey text-center q-mt-xl">
      No lists yet. Create your first one above.
    </div>

    <!-- `update:model-value` rather than `v-model`: the new order goes back through an
         action, which is also what persists it. Bound to the visible lists, so a list
         waiting to be deleted on the server is not in the order the user drags. -->
    <draggable
      :model-value="store.visibleLists"
      item-key="id"
      handle=".drag-handle"
      :animation="150"
      :force-fallback="true"
      class="q-list q-list--bordered q-list--separator rounded-borders"
      @update:model-value="store.reorderLists"
    >
      <template #item="{ element: list }">
        <q-item clickable v-ripple class="q-pl-none" @click="open(list.id)">
          <q-item-section side style="width: 32px; min-width: 32px" class="items-center">
            <q-icon name="drag_indicator" class="drag-handle" color="grey-6" @click.stop />
          </q-item-section>
          <q-item-section>
            <q-item-label>
              {{ list.name }}
              <!-- Titles stay readable whatever a list's flag says (§1), so this is the only
                   thing that tells the two kinds apart on the index. -->
              <q-icon
                v-if="list.encrypted"
                name="lock"
                size="14px"
                color="grey-7"
                class="q-ml-xs"
              />
            </q-item-label>
            <q-item-label caption>{{ list.items_count }} item(s)</q-item-label>
          </q-item-section>
          <q-item-section side style="width: 20px; min-width: 20px" class="q-pl-none">
            <q-btn
              flat
              round
              dense
              size="sm"
              padding="none"
              tabindex="-1"
              icon="delete"
              color="negative"
              @click.stop="remove(list)"
            />
          </q-item-section>
        </q-item>
      </template>
    </draggable>
  </q-page>
</template>

<script>
import draggable from 'vuedraggable'
import { isNetworkError } from 'src/api'
import EncryptionDialog from 'src/components/EncryptionDialog.vue'
import ImportFromKeepDialog from 'src/components/ImportFromKeepDialog.vue'
import InstallHint from 'src/components/InstallHint.vue'
import StaleDataNotice from 'src/components/StaleDataNotice.vue'
import retryWhenOnline from 'src/mixins/retryWhenOnline'
import { useAuthStore } from 'src/stores/auth'
import { useEncryptionStore } from 'src/stores/encryption'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { useTrashStore } from 'src/stores/trash'
import { RETENTION_DAYS } from 'src/utils/trashClock'

export default {
  name: 'ShoppingListsPage',

  components: { draggable, EncryptionDialog, ImportFromKeepDialog, InstallHint, StaleDataNotice },

  mixins: [retryWhenOnline],

  data() {
    return {
      newName: '',
      importing: false,
      encrypting: false,
      loading: false,
      creating: false,
      loadFailed: false,
    }
  },

  computed: {
    authStore() {
      return useAuthStore()
    },

    encryption() {
      return useEncryptionStore()
    },

    store() {
      return useShoppingListsStore()
    },

    trash() {
      return useTrashStore()
    },
  },

  mounted() {
    this.load()
  },

  methods: {
    async load() {
      this.loading = true
      this.loadFailed = false
      try {
        await this.store.fetchLists()
      } catch (err) {
        // No encryption case to handle here, and that is the design rather than an omission: the
        // index is titles and counts, both plaintext however a list is stored (§1), so this page
        // never needs a key and never has to explain itself.
        //
        // Offline with lists already in the store: keep showing them. They are the same
        // records the editor works on, so at worst they are a little stale — while an empty
        // page would suggest the lists are gone.
        if (!isNetworkError(err) || !this.store.visibleLists.length) this.loadFailed = true
      } finally {
        this.loading = false
      }
    },

    async create() {
      const name = this.newName.trim()
      if (!name || this.creating) return
      this.creating = true
      try {
        // Succeeds offline too — the list is created locally and pushed later — so the only
        // way here is a refusal from the server, e.g. a name it will not accept.
        const list = await this.store.createList(name)
        this.newName = ''
        this.$router.push(`/list/${list.id}`)
      } catch {
        // Nothing was created, so there is nothing to undo — keep the typed name so the
        // button can simply be pressed again.
        this.$q.notify({ type: 'negative', message: 'Could not create the list.' })
      } finally {
        this.creating = false
      }
    },

    open(id) {
      this.$router.push(`/list/${id}`)
    },

    remove(list) {
      this.$q.dialog({
        title: 'Delete list',
        // The window comes from `RETENTION_DAYS`; see its docblock for why that is a
        // client-side literal rather than something the server tells us.
        message:
          `Delete "${list.name}"? It goes to the trash, where you can put it back ` +
          `for the next ${RETENTION_DAYS} days.`,
        cancel: true,
        ok: { label: 'Delete', color: 'negative' },
      }).onOk(async () => {
        // The row goes immediately either way; offline the deletion is queued, which needs no
        // announcement. Only the server actively refusing is worth a word.
        if ((await this.store.deleteList(list.id)) === 'failed') {
          this.$q.notify({ type: 'negative', message: 'Could not delete the list.' })
        }
      })
    },

    // Only worth a retry if the last attempt actually failed — a successful index does not
    // need refetching just because the connection blinked. `stale` is part of that: falling
    // back to the cached lists leaves `loadFailed` false, and without this the notice saying
    // they are unconfirmed would still be true and never get a chance to stop being true.
    retryWhenOnline() {
      if (this.loadFailed || this.store.stale) this.load()
    },

    /**
     * What both ways of leaving have to do on this device, and **before the session ends**.
     *
     * The lists outlive this page, so they have to go explicitly — otherwise the next person to
     * sign in sees them until their own fetch lands. The same for the key: leaving it in memory
     * would let the next account's ciphertext be "decrypted" with somebody else's DEK, which
     * fails in the least obvious way possible.
     *
     * The ordering is the part that is easy to get wrong, because getting it wrong is silent.
     * Both caches are keyed by `authStore.user.uid`, and `logout` clears that — so called
     * afterwards, these two clear the key for `anon` and leave the real ones sitting on the
     * device. That is what this used to do.
     */
    clearLocalState() {
      this.store.clear()
      // For exactly the same reason, and with the same ordering trap: the trash cache is keyed
      // by uid too, and it holds the names of the departing account's deleted lists — plus the
      // contents of any that were opened on this device.
      this.trash.clear()
      this.encryption.reset()
    },

    async onLogout() {
      this.clearLocalState()
      await this.authStore.logout()
      this.$router.push('/login')
    },

    /**
     * The one action in the app with no undo and no server-side copy to recover from — Play's
     * User Data policy requires it to be reachable from inside the app, and the privacy policy
     * describes exactly what it removes.
     *
     * `persistent` because a tap outside the dialog is not consent, and the button says what it
     * does rather than "OK" — this menu entry sits one row below "Log out", and the two must not
     * be confusable at the moment of confirming.
     */
    onDeleteAccount() {
      this.$q.dialog({
        title: 'Delete account',
        message:
          'This deletes your account, every list on it, and the keys to your locked lists. ' +
          'Nobody can undo it or recover the contents afterwards — not even the developer, ' +
          'because the server never had the keys.',
        cancel: true,
        persistent: true,
        ok: { label: 'Delete everything', color: 'negative' },
      }).onOk(async () => {
        try {
          await this.authStore.deleteAccount()
        } catch (err) {
          // Nothing local has been touched, so the session is still usable and the only thing
          // to do is say so. Unlike a list edit this cannot be queued for later: a deletion
          // that happens whenever the connection returns is not something to leave armed.
          this.$q.notify({
            type: 'negative',
            message: isNetworkError(err)
              ? 'You need to be online to delete your account.'
              : 'Could not delete your account.',
          })
          return
        }
        // Caches first, as on logout, and then `endSession` rather than `logout` — a request now
        // would resurrect the account through the 401 recovery path. See `deleteAccount` in the
        // auth store.
        this.clearLocalState()
        await this.authStore.endSession()
        this.$router.push('/login')
      })
    },
  },
}
</script>

<style scoped>
.drag-handle {
  cursor: grab;
}
.drag-handle:active {
  cursor: grabbing;
}
</style>
