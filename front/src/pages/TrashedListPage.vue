<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <!-- The three "this is not the list" states, the same three the editor has and for the
         same reasons — see `ShoppingListPage`. The first one is now only reachable for a list
         this device has never opened: one that has been inspected before is served from its
         cached payload instead. -->
    <ShoppingListUnavailable v-if="loadFailed" :retrying="loading" @back="toTrash" @retry="load" />

    <ShoppingListLocked
      v-else-if="locked"
      :unlocking="encryption.busy"
      :error="unlockError"
      @back="toTrash"
      @unlock="unlock"
    />

    <div v-else-if="!record">
      <div class="row items-center q-mb-md">
        <q-btn flat round dense icon="arrow_back" @click="toTrash" />
      </div>
      <q-inner-loading showing />
    </div>

    <template v-else>
      <div class="row items-center no-wrap q-mb-sm">
        <q-btn flat round dense icon="arrow_back" class="self-start" @click="toTrash" />
        <!-- Plain text, not the editor's input: the title of a trashed list is not something
             that can be typed into, and offering a text field that silently discards what is
             typed in it would be worse than offering nothing. -->
        <div class="text-h6 text-weight-bold q-ml-sm">
          {{ record.name }}
          <q-icon v-if="record.encrypted" name="lock" size="16px" color="grey-7" class="q-ml-xs" />
        </div>
      </div>

      <q-banner dense rounded class="bg-grey-2 q-mb-md">
        <template #avatar><q-icon name="delete_outline" color="grey-8" /></template>
        <div class="text-body2">
          In the trash — {{ deletesIn(record.purge_at) }}. Put it back to make changes.
        </div>
        <!-- Reachable by opening this URL again after queueing something for this list: the
             decision is already made and saved, so the two buttons would only queue it twice.
             The lists' words for the same state — the change is safe here and on its way. -->
        <template #action>
          <div v-if="queued" class="row items-center q-gutter-xs text-grey q-mr-sm">
            <q-icon name="cloud_off" size="16px" />
            <span class="text-caption">Saved on this device, waiting to sync</span>
          </div>
          <template v-else>
            <q-btn flat no-caps color="primary" icon="restore" label="Restore" @click="restore" />
            <q-btn
              flat
              no-caps
              color="negative"
              icon="delete_forever"
              label="Delete for good"
              @click="purge"
            />
          </template>
        </template>
      </q-banner>

      <q-list v-if="record.items.length" bordered separator class="rounded-borders">
        <q-item v-for="item in record.items" :key="item._key">
          <!-- Shown as it was left, and not clickable. `disable` rather than a read-only
               checkbox because it has to look inert as well as be inert. -->
          <q-item-section
            v-if="record.show_checkbox"
            side
            style="width: 32px; min-width: 32px"
            class="items-center q-pl-none"
          >
            <q-checkbox :model-value="item.checked" dense size="sm" disable tabindex="-1" />
          </q-item-section>
          <q-item-section>
            <q-item-label :class="struck(item) ? 'row-checked' : ''">{{ item.name }}</q-item-label>
          </q-item-section>
          <q-item-section
            v-if="record.show_quantity"
            side
            style="width: 56px; min-width: 56px"
            class="items-center"
          >
            <span :class="struck(item) ? 'row-checked' : ''">{{ item.quantity }}</span>
          </q-item-section>
        </q-item>
      </q-list>

      <div v-else class="text-grey text-center q-my-lg">This list has no items.</div>
    </template>
  </q-page>
</template>

<script>
import ShoppingListLocked from 'src/components/ShoppingListLocked.vue'
import ShoppingListUnavailable from 'src/components/ShoppingListUnavailable.vue'
import { isNetworkError } from 'src/api'
import retryWhenOnline from 'src/mixins/retryWhenOnline'
import { useEncryptionStore } from 'src/stores/encryption'
import { isQueued, useTrashStore } from 'src/stores/trash'
import { deletesIn } from 'src/utils/trashClock'

/**
 * One trashed list, to look at before deciding what to do with it.
 *
 * **Read-only by construction, not by hiding buttons.** The record it renders comes from the
 * trash store and lives in this component alone: it is not in the lists store, so nothing
 * watches it, nothing debounces a save for it and nothing syncs it — there is no code path
 * from this page to a write. The server agrees from the other side (`TrashController` has no
 * write endpoint), so the two halves say the same thing.
 *
 * It also opens offline, from the copy the store cached the first time it was read. Safe
 * precisely because of the paragraph above: a list nobody can write to cannot go stale, so an
 * old copy of one is not an old copy of anything — it is the list.
 *
 * Encrypted lists are read here exactly as in the editor: the rows arrive as ciphertext and
 * the seam opens them, so a locked session gets the same fingerprint prompt rather than a
 * page of base64.
 */
export default {
  name: 'TrashedListPage',

  components: { ShoppingListLocked, ShoppingListUnavailable },

  mixins: [retryWhenOnline],

  data() {
    return {
      record: null,
      loading: false,
      loadFailed: false,
      locked: false,
      unlockError: '',
    }
  },

  computed: {
    trash() {
      return useTrashStore()
    },

    encryption() {
      return useEncryptionStore()
    },

    listId() {
      return Number(this.$route.params.id)
    },

    /** A restore or a purge already decided for this list and not sent yet. */
    queued() {
      const entry = this.trash.entries.find((e) => e.id === this.listId)

      return !!entry && isQueued(entry)
    },
  },

  watch: {
    '$route.params.id': 'load',

    // The key arrived — here, or on another list earlier in the session. Same trigger as the
    // editor's: nothing else would turn a refused read into a readable list.
    'encryption.unlocked'(unlocked) {
      if (unlocked && this.locked) this.load()
    },
  },

  mounted() {
    this.load()
  },

  methods: {
    deletesIn,

    struck(item) {
      return this.record.show_checkbox && item.checked
    },

    toTrash() {
      this.$router.push('/trash')
    },

    async load() {
      this.loading = true
      this.loadFailed = false
      this.locked = false
      try {
        this.record = await this.trash.view(this.listId)
      } catch (err) {
        // Encrypted and no key yet: a prompt waiting to be answered rather than a failure, so
        // the page offers the fingerprint instead of a retry that would fail the same way.
        if (err.name === 'EncryptionLockedError') {
          this.locked = true
          return
        }
        // A definite answer — restored elsewhere, already purged, or never ours — means there
        // is nothing on this page to come back to, so go where the list now is not.
        if (!isNetworkError(err)) {
          this.toTrash()
          return
        }
        // Offline and never read on this device, so there is no cached copy to serve.
        this.loadFailed = true
      } finally {
        this.loading = false
      }
    },

    retryWhenOnline() {
      if (this.loadFailed) this.load()
    },

    async unlock() {
      this.unlockError = ''
      try {
        await this.encryption.unlock()
      } catch (err) {
        this.unlockError = err.message ?? 'Could not unlock.'
      }
    },

    /**
     * Put it back, and go where it has gone.
     *
     * Straight into the restored list when the server has actually taken it — whoever came here
     * to check it wants it back open. Not when the restore is only queued: the index has no
     * record of the list yet, so that URL would open the editor's "can't reach the server"
     * screen for a list that is perfectly safe.
     */
    async restore() {
      const name = this.record.name
      const outcome = await this.trash.restore(this.listId)
      // A second tap while the first is in flight: it is the first one's job to say what
      // happened and where to go next.
      if (outcome === 'queued') return
      if (outcome === 'saved') {
        this.$q.notify({ type: 'positive', message: `"${name}" is back in your lists.` })
        this.$router.push(`/list/${this.listId}`)
        return
      }
      // 'gone' is the store's own warning, already shown — it was destroyed elsewhere before
      // this device could put it back, and a second notice would only argue with it.
      if (outcome === 'offline') {
        this.$q.notify({
          type: 'info',
          message: `Saved on this device — "${name}" goes back in your lists as soon as there is a connection.`,
        })
      }
      if (outcome === 'failed') {
        this.$q.notify({
          type: 'negative',
          message: `Couldn't restore "${name}" yet — this device will keep trying.`,
        })
      }
      this.toTrash()
    },

    purge() {
      this.$q
        .dialog({
          title: 'Delete permanently',
          message:
            `Delete "${this.record.name}" and its ${this.record.items.length} item(s) for good? ` +
            'This cannot be undone.',
          cancel: true,
          persistent: true,
          ok: { label: 'Delete for good', color: 'negative' },
        })
        .onOk(async () => {
          const name = this.record.name
          const outcome = await this.trash.purge(this.listId)
          if (outcome === 'queued') return
          // Restored elsewhere, so nothing was deleted — the store has said so. The trash is the
          // one place this list is now certainly not, so go where it is instead.
          if (outcome === 'restored') {
            this.$router.push('/')
            return
          }
          if (outcome === 'offline') {
            this.$q.notify({
              type: 'info',
              message: `Saved on this device — "${name}" is deleted for good as soon as there is a connection.`,
            })
          }
          if (outcome === 'failed') {
            this.$q.notify({
              type: 'negative',
              message: `Couldn't delete "${name}" yet — this device will keep trying.`,
            })
          }
          this.toTrash()
        })
    },
  },
}
</script>

<style scoped>
/* The same struck-through row the editor shows, so a checked item looks checked here too. */
.row-checked {
  text-decoration: line-through;
  opacity: 0.55;
}
</style>
