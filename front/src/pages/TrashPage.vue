<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <div class="row items-center q-mb-md">
      <q-btn flat round dense icon="arrow_back" @click="$router.push('/')" />
      <div class="text-h6 text-weight-bold q-ml-sm">Trash</div>
    </div>

    <div class="text-grey q-mb-md text-body2">
      A deleted list is kept here and then removed for good. Open one to check what is in it, put it
      back, or delete it now.
    </div>

    <!-- Only when there is nothing to cover: the trash is cached and rendered on the first
         frame, and `load()` runs on every arrival, so an unconditional overlay would hide a
         perfectly good list behind a spinner for as long as the request took. -->
    <q-inner-loading :showing="loading && !store.loaded" />

    <!-- The lists' `StaleDataNotice` in the same words, but not the component: that one reads
         the lists store directly by design, and this page is asking the same question of a
         different store. Silent when there is nothing cached: "showing the copy saved on this
         device" and "nothing has been saved on this device" cannot both be on screen. -->
    <div
      v-if="store.stale && !nothingToShow"
      class="row items-center q-gutter-xs q-mb-sm text-grey"
    >
      <q-icon name="cloud_off" size="16px" />
      <span class="text-caption">Not connected — showing the copy saved on this device</span>
    </div>

    <!-- Restores and delete-for-goods are queued like every other change in this app, so the
         only thing worth saying is that some are still waiting. It matters more here than on
         the index: a restored list is in neither place until this reaches zero. -->
    <div v-if="store.pendingCount" class="row items-center q-gutter-xs q-mb-sm text-grey">
      <q-spinner v-if="store.syncing" size="14px" />
      <q-icon v-else name="cloud_off" size="16px" />
      <span class="text-caption">
        {{ store.syncing ? 'Syncing…' : `${store.pendingCount} action(s) waiting to sync` }}
      </span>
    </div>

    <!-- Deletions made offline are not on the server yet, so they are not in this list — and a
         user who just deleted three lists on a train would otherwise find the trash empty and
         conclude they are gone for good. -->
    <div v-if="pendingDeletes" class="row items-center q-gutter-xs q-mb-sm text-grey">
      <q-icon name="cloud_off" size="16px" />
      <span class="text-caption">
        {{ pendingDeletes }} deletion(s) haven't reached the server yet — they'll show up here once
        they do.
      </span>
    </div>

    <!-- Only reachable with nothing cached to fall back on: with a copy on the device it is
         shown instead, with the notice above saying so. -->
    <div v-if="nothingToShow" class="text-center q-mt-xl">
      <q-icon name="cloud_off" size="48px" color="grey-6" />
      <div class="text-subtitle1 q-mt-sm">Can't load the trash</div>
      <div class="text-grey q-mt-xs">
        Nothing has been saved on this device yet, and the trash could not be loaded.
      </div>
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

    <div v-else-if="store.loaded && !store.count" class="text-grey text-center q-mt-xl">
      Nothing in the trash.
    </div>

    <q-list v-else bordered separator class="rounded-borders">
      <q-item
        v-for="entry in store.visibleEntries"
        :key="entry.id"
        clickable
        v-ripple
        @click="$router.push(`/trash/list/${entry.id}`)"
      >
        <q-item-section>
          <q-item-label>
            {{ entry.name }}
            <!-- Same as on the index: titles are readable whatever the list's flag says, so
                 this padlock is the only thing that tells the two kinds apart. -->
            <q-icon v-if="entry.encrypted" name="lock" size="14px" color="grey-7" class="q-ml-xs" />
          </q-item-label>
          <q-item-label caption>
            {{ entry.items_count }} item(s) · {{ deletedAgo(entry.deleted_at) }},
            <span :class="expiringSoon(entry) ? 'text-negative' : ''">
              {{ deletesIn(entry.purge_at) }}
            </span>
          </q-item-label>
        </q-item-section>
        <!-- No per-row spinner: either action takes the row off the screen the moment it is
             tapped, whether or not the server has heard about it yet.

             The row class goes on a wrapper rather than on the section: `QItemSection` puts its
             own `column` on itself, which wins, and the two buttons end up stacked.

             Both are reachable by keyboard, unlike the index's delete button, which is
             deliberately `tabindex="-1"`: there the row is the thing and delete is incidental,
             here the two actions are the only reason the screen exists. -->
        <q-item-section side>
          <div class="row no-wrap items-center q-gutter-xs">
            <q-btn
              flat
              round
              dense
              size="sm"
              icon="restore"
              color="primary"
              @click.stop="restore(entry)"
            >
              <q-tooltip>Put this list back</q-tooltip>
            </q-btn>
            <q-btn
              flat
              round
              dense
              size="sm"
              icon="delete_forever"
              color="negative"
              @click.stop="purge(entry)"
            >
              <q-tooltip>Delete now, for good</q-tooltip>
            </q-btn>
          </div>
        </q-item-section>
      </q-item>
    </q-list>
  </q-page>
</template>

<script>
import { isNetworkError } from 'src/api'
import retryWhenOnline from 'src/mixins/retryWhenOnline'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { useTrashStore } from 'src/stores/trash'
import { daysLeft, deletedAgo, deletesIn } from 'src/utils/trashClock'

/**
 * What has been deleted and is not gone yet: read it, put it back, or finish the job.
 *
 * There is no editing here and no way to reach any, which is the whole shape of this screen — a
 * trashed list is not a list you are working on, and the server refuses to write to one anyway
 * (`TrashController`).
 *
 * Both actions are queued rather than awaited, like every other change in the app, so neither
 * of them can fail for want of a connection — see the store. What that costs is stated on
 * screen rather than hidden: until the queue drains, a restored list is in neither place.
 */
export default {
  name: 'TrashPage',

  mixins: [retryWhenOnline],

  data() {
    return {
      loading: false,
      loadFailed: false,
    }
  },

  computed: {
    store() {
      return useTrashStore()
    },

    /** Tombstones the lists store is still holding — see the note in the template. */
    pendingDeletes() {
      return useShoppingListsStore().lists.filter((l) => l.pendingDelete).length
    },

    /** The read failed and there is no copy on the device, so the page has nothing on it. */
    nothingToShow() {
      return this.loadFailed && !this.store.loaded
    },
  },

  mounted() {
    this.load()
  },

  methods: {
    deletedAgo,
    deletesIn,

    /** The last week of the window, when "how long have I got" stops being idle curiosity. */
    expiringSoon(entry) {
      const left = daysLeft(entry.purge_at)

      return left !== null && left <= 7
    },

    async load() {
      this.loading = true
      this.loadFailed = false
      try {
        await this.store.fetch()
      } catch (err) {
        // Offline with a cached trash: keep showing it, with the notice above saying it is
        // unconfirmed. Anything else — or nothing cached — is a page with nothing on it.
        if (!isNetworkError(err) || !this.store.loaded) this.loadFailed = true
      } finally {
        this.loading = false
      }
    },

    // Worth a retry only if the last attempt failed, or succeeded from the cache: `stale` is
    // what makes the second case visible, and without it the notice saying the trash is
    // unconfirmed would never get a chance to stop being true.
    retryWhenOnline() {
      if (this.loadFailed || this.store.stale) this.load()
    },

    async restore(entry) {
      const outcome = await this.store.restore(entry.id)
      // 'gone' is the store's own warning, already shown: the list was destroyed elsewhere
      // before this device could put it back, and a second notice would only argue with it.
      // 'queued' is a second tap on a row that is already on its way; the first tap speaks.
      if (outcome === 'gone' || outcome === 'queued') return
      this.$q.notify(
        {
          saved: { type: 'positive', message: `"${entry.name}" is back in your lists.` },
          offline: {
            type: 'info',
            message: `Saved on this device — "${entry.name}" goes back in your lists as soon as there is a connection.`,
          },
          failed: {
            type: 'negative',
            message: `Couldn't restore "${entry.name}" yet — this device will keep trying.`,
          },
        }[outcome],
      )
    },

    /**
     * `persistent`, and the button says what it does: this is the one action on this screen
     * that nothing can undo, and it sits a few pixels from the one that saves the list.
     */
    purge(entry) {
      this.$q
        .dialog({
          title: 'Delete permanently',
          message:
            `Delete "${entry.name}" and its ${entry.items_count} item(s) for good? ` +
            'This cannot be undone.',
          cancel: true,
          persistent: true,
          ok: { label: 'Delete for good', color: 'negative' },
        })
        .onOk(async () => {
          const outcome = await this.store.purge(entry.id)
          // Nothing to say when it worked — the row is gone, which is the whole message. Nor on
          // a second tap of a row already on its way out, nor on 'restored': that one is the
          // store's own warning that the list was put back elsewhere and so was not deleted.
          if (['saved', 'queued', 'restored'].includes(outcome)) return
          this.$q.notify(
            outcome === 'offline'
              ? {
                  type: 'info',
                  message: `Saved on this device — "${entry.name}" is deleted for good as soon as there is a connection.`,
                }
              : {
                  type: 'negative',
                  message: `Couldn't delete "${entry.name}" yet — this device will keep trying.`,
                },
          )
        })
    },
  },
}
</script>
