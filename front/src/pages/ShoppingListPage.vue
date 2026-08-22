<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <!-- The list could not be fetched, so there is nothing to edit: the whole editor is
         replaced rather than shown empty. An empty editor would invite typing into rows
         that can never be saved — `markLoaded()` never ran, so every keystroke would be
         silently dropped — and would offer a title and column toggles that only PUT. -->
    <ShoppingListUnavailable
      v-if="loadFailed"
      :retrying="loading"
      @back="$router.push('/')"
      @retry="retry"
    />

    <!-- Encrypted, and this session has no key yet. The editor is replaced rather than shown
         empty for the same reason as above, and because the rows genuinely are not here: they
         are on the server as ciphertext until a fingerprint says otherwise. -->
    <ShoppingListLocked
      v-else-if="locked"
      :unlocking="encryption.busy"
      :error="unlockError"
      @back="$router.push('/')"
      @unlock="unlock"
    />

    <!-- Not cached, and the fetch is still out. The editor is replaced for the third and last
         time, and for the same reason as the two above: an empty editor here is not this list,
         it is the absence of it — `markLoaded()` has not run, so anything typed into it would
         be dropped, and "No items yet." would be a statement we cannot make yet. -->
    <ShoppingListLoading
      v-else-if="!store.isLoaded"
      :name="store.listName"
      :rows="store.current?.items_count ?? 3"
      @back="$router.push('/')"
    />

    <template v-else>
      <ShoppingListHeader
        :searching="searchOpen"
        :encrypted="!!store.currentEncrypted"
        :lock-busy="lockBusy"
        @back="goBack"
        @toggle-search="toggleSearch"
        @toggle-lock="toggleLock"
      />

      <EncryptionDialog v-model="settingUpKey" />

      <!-- Search, folded away behind the header's icon until asked for. `v-if` rather than
           `v-show` so the row costs nothing while closed, which is the whole point. -->
      <q-input
        v-if="searchOpen"
        ref="searchInput"
        v-model="query"
        outlined
        dense
        clearable
        debounce="150"
        placeholder="Search by name"
        class="q-mb-md"
      >
        <template #prepend><q-icon name="search" /></template>
      </q-input>

      <StaleDataNotice />

      <ShoppingListSaveStatus />

      <!-- Rows. `update:model-value` rather than `v-model`, so the reordered array goes
           back through an action instead of being written into the store from here. -->
      <draggable
        :model-value="store.items"
        item-key="_key"
        handle=".drag-handle"
        :animation="150"
        :disabled="!!query"
        :force-fallback="true"
        class="q-list q-list--bordered q-list--separator rounded-borders"
        @update:model-value="store.reorder"
        @start="store.beginDrag"
        @end="store.endDrag"
      >
        <!-- The row reads its own data out of the store, so it only needs to be told
             where it sits. `element` is still used here for the two things that are not
             the row's own business: whether the search hides it, and its focus ref. -->
        <template #item="{ element: item, index }">
          <ShoppingListRow
            v-show="matchesQuery(item)"
            :ref="(el) => setRowRef(item._key, el)"
            :index="index"
            :searching="!!query"
            @name-enter="(start, end) => onNameEnter(item, index, start, end)"
            @name-backspace="onNameBackspace(index)"
            @qty-enter="focusName(store.addRowAfter(index))"
          />
        </template>
      </draggable>

      <!-- A new row is always appended at the end, so while a search is filtering the
           list it would land out of view — disable it until the search is cleared.

           The row is left unfocused on purpose: the button sits under the last row, so
           focusing would open the on-screen keyboard over the very list the user is
           adding to. The row is there to tap when they are ready to type in it. -->
      <q-btn
        flat
        dense
        no-caps
        icon="add"
        label="Add item"
        color="primary"
        class="full-width q-mt-sm"
        :disable="!!query"
        @click="store.addRow()"
      >
        <q-tooltip v-if="query">Clear the search to add items</q-tooltip>
      </q-btn>

      <!-- Only a list that is nothing but whole numbers gets one; the store decides, see
           `numericTotal`. It totals the whole list rather than what the search leaves on
           screen — the total belongs to the list, not to the current filter. -->
      <div
        v-if="store.numericTotal !== null"
        class="row items-center justify-between q-mt-md q-px-sm text-subtitle1"
      >
        <span class="text-grey-7">Total</span>
        <div class="row items-center no-wrap q-gutter-sm">
          <span class="text-weight-medium">{{ store.numericTotal }}</span>
          <!-- The counting is done, so put the answer where the figures were. Left
               undoable rather than behind a confirmation: Ctrl+Z brings the rows back,
               and the store records it as one step. Disabled under a search for the same
               reason "Add item" is — it would act on rows that are not on screen, and
               here that means deleting them. -->
          <q-btn
            flat
            dense
            no-caps
            icon="compress"
            label="Squash"
            color="primary"
            :disable="!!query"
            @click="store.squashRows()"
          >
            <q-tooltip>{{
              query ? 'Clear the search to squash' : 'Replace every row with the total'
            }}</q-tooltip>
          </q-btn>
        </div>
      </div>

      <div v-if="visibleCount === 0" class="text-grey text-center q-my-lg">
        {{ query ? 'No items match your search.' : 'No items yet.' }}
      </div>
    </template>
  </q-page>
</template>

<script>
import draggable from 'vuedraggable'
import EncryptionDialog from 'src/components/EncryptionDialog.vue'
import ShoppingListHeader from 'src/components/ShoppingListHeader.vue'
import ShoppingListLoading from 'src/components/ShoppingListLoading.vue'
import ShoppingListLocked from 'src/components/ShoppingListLocked.vue'
import ShoppingListRow from 'src/components/ShoppingListRow.vue'
import ShoppingListSaveStatus from 'src/components/ShoppingListSaveStatus.vue'
import ShoppingListUnavailable from 'src/components/ShoppingListUnavailable.vue'
import StaleDataNotice from 'src/components/StaleDataNotice.vue'
import flushOnHide from 'src/mixins/flushOnHide'
import retryWhenOnline from 'src/mixins/retryWhenOnline'
import rowRefs from 'src/mixins/rowRefs'
import undoRedoShortcuts from 'src/mixins/undoRedoShortcuts'
import { useEncryptionStore } from 'src/stores/encryption'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { isNetworkError } from 'src/api'

export default {
  name: 'ShoppingListPage',

  components: {
    draggable,
    EncryptionDialog,
    ShoppingListHeader,
    ShoppingListLoading,
    ShoppingListLocked,
    ShoppingListRow,
    ShoppingListSaveStatus,
    ShoppingListUnavailable,
    StaleDataNotice,
  },

  // `rowRefs` gives this page `setRowRef`/`focusName`/`focusQty`/`regrowNames`; the other
  // three bind a listener each and call back into the methods below.
  mixins: [rowRefs, undoRedoShortcuts, flushOnHide, retryWhenOnline],

  data() {
    return {
      query: '',
      searchOpen: false,
      loadFailed: false,
      loading: false,
      // The server holds this list encrypted and this session has no key: not a failure, a prompt
      // waiting to be answered. Kept separate from `loadFailed` because the two offer opposite
      // things — a retry button is useless here, and a fingerprint is useless there.
      locked: false,
      unlockError: '',
      lockBusy: false,
      settingUpKey: false,
    }
  },

  computed: {
    store() {
      return useShoppingListsStore()
    },

    encryption() {
      return useEncryptionStore()
    },

    visibleCount() {
      return this.store.items.filter(this.matchesQuery).length
    },
  },

  watch: {
    // vue-router reuses this component for /list/1 -> /list/2, so `mounted` does not
    // run again — without this, switching lists would keep showing the old one.
    '$route.params.id': 'openList',

    // Toggling a column changes the name column's width, and Quasar's `autogrow` only
    // re-measures on input — so re-measure whenever either toggle lands, including when it
    // lands because a newer copy of the list arrived from the server.
    'store.showQuantity': 'regrowNames',
    'store.showCheckbox': 'regrowNames',

    // The key arrived — from the panel below, or from another list unlocked earlier in the
    // session. Either way this is what turns a refused read into an open list; nothing else would.
    'encryption.unlocked'(unlocked) {
      if (unlocked && this.locked) this.retry()
    },
  },

  // Opened here rather than in `mounted` so a cached list is already on screen at the
  // first render, with no empty frame in between.
  created() {
    this.openList(this.$route.params.id)
  },

  // The debounced save outlives this page, so a pending one has to be fired on the way out
  // rather than left on a timer that nothing will reach.
  beforeUnmount() {
    this.store.stopSaving()
  },

  methods: {
    // ---- what the mixins call ----

    undo() {
      this.store.undo()
    },

    redo() {
      this.store.redo()
    },

    flushBeforeHide() {
      return this.store.flush()
    },

    // Two cases, and only these two. A list we could not reach at all is worth opening again;
    // one that opened from cache and was never confirmed is worth asking about again, which is
    // also the only thing that can retire the "not connected" notice above it. A list that
    // opened normally needs neither just because the connection blinked.
    retryWhenOnline() {
      if (this.loadFailed) this.retry()
      else if (this.store.stale) this.store.refreshOpen()
    },

    // ---- the rows ----

    // With a quantity column, Enter is a move between the two fields of the same row — the
    // name is only half of it. Without one, the name *is* the row, so Enter ends it and
    // starts the next: the text after the caret goes down with it, and the caret follows,
    // landing at the seam.
    onNameEnter(item, index, start, end) {
      if (this.store.showQuantity) {
        this.focusQty(item._key)
        return
      }
      // Close the open edit before the split records its own step, or the two land on the
      // undo stack in the order they were finished rather than the order they happened.
      this.store.endEdit()
      this.focusName(this.store.splitRow(index, start, end), 0)
    },

    // The other direction, and only where Enter splits: Backspace from the start of a name
    // takes the row up into the one above, leaving the caret on the seam. A row with a
    // quantity is more than its name, so joining two of them would quietly drop one — there
    // the key stays an ordinary delete.
    onNameBackspace(index) {
      if (this.store.showQuantity) return
      this.store.endEdit()
      const joined = this.store.mergeRowUp(index)
      if (joined) this.focusName(joined.key, joined.caret)
    },

    // ---- search ----
    //
    // Closing clears the query as well as the field. A filter left running behind a folded
    // box would be invisible: rows missing from the list, "Add item" disabled, and nothing on
    // screen saying why.
    toggleSearch() {
      this.searchOpen = !this.searchOpen
      if (this.searchOpen) this.$nextTick(() => this.$refs.searchInput?.focus())
      else this.query = ''
    },

    matchesQuery(item) {
      const q = (this.query || '').trim().toLowerCase()
      return !q || item.name.toLowerCase().includes(q)
    },

    async goBack() {
      await this.store.flush()
      this.$router.push('/')
    },

    // ---- opening a list ----
    //
    // The store owns the switch itself — firing the outgoing list's pending save, resetting
    // its history, and either serving the new list from cache or fetching it. All this page
    // decides is where a failure sends the user.
    async openList(id) {
      this.loadFailed = false
      this.locked = false
      this.loading = true
      try {
        this.focusName(await this.store.open(id))
      } catch (err) {
        // Encrypted, and the key is not here yet — which is the normal way to arrive at a locked
        // list, since nothing asks for a fingerprint until one is opened. Not a failure and not a
        // verdict: the panel offers the prompt, and the watcher above opens the list once it is
        // answered. Bouncing home would lose the list the user asked for.
        if (err.name === 'EncryptionLockedError') {
          this.locked = true
          return
        }
        // Two very different failures land here. A response — 404, or 403 for someone
        // else's list — is the server's final word, and bouncing home is right. A
        // transport failure is not a verdict on the list: offline it is simply
        // unreachable for now, and ejecting would send the user to a home page that
        // cannot load either, i.e. the list becomes unopenable rather than merely stale.
        if (!isNetworkError(err)) {
          this.$router.replace('/')
          return
        }
        this.loadFailed = true
      } finally {
        this.loading = false
      }
    },

    retry() {
      if (!this.loading) this.openList(this.$route.params.id)
    },

    // ---- the lock ----

    /**
     * Answer the prompt.
     *
     * Every failure is shown, the dismissed prompt included: the platform reports "you cancelled"
     * and "no passkey here can open this" identically (see `PasskeyCancelledError`), so silence
     * would be indistinguishable from a broken button in the case where it matters most.
     */
    async unlock() {
      this.unlockError = ''
      try {
        await this.encryption.unlock()
      } catch (err) {
        this.unlockError = err.message ?? 'Could not unlock.'
      }
    },

    /**
     * Encrypt this list, or stop.
     *
     * Three states to get through before the flag can move: no key for this account at all (send
     * them to set one up), a key this session has not opened (ask for the fingerprint), and then
     * the write itself. Turning encryption *off* needs no key beyond the one that decrypted the
     * rows already on screen.
     */
    async toggleLock() {
      const encrypting = !this.store.currentEncrypted

      if (encrypting && !this.encryption.enabled) {
        this.settingUpKey = true
        return
      }
      if (encrypting && !this.encryption.unlocked) {
        await this.unlock()
        if (!this.encryption.unlocked) return
      }

      this.lockBusy = true
      try {
        await this.store.setEncrypted(encrypting)
        this.$q.notify({
          type: 'positive',
          message: encrypting
            ? 'This list is now encrypted. Only your passkeys can open it.'
            : 'This list is no longer encrypted.',
        })
      } catch {
        this.$q.notify({ type: 'negative', message: 'Could not change that.' })
      } finally {
        this.lockBusy = false
      }
    },
  },
}
</script>
