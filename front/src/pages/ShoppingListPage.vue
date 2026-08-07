<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <!-- The list could not be fetched, so there is nothing to edit: the whole editor is
         replaced rather than shown empty. An empty editor would invite typing into rows
         that can never be saved — `markLoaded()` never ran, so every keystroke would be
         silently dropped — and would offer a title and column toggles that only PUT. -->
    <ShoppingListUnavailable
      v-if="loadFailed"
      :retrying="loading"
      @back="router.push('/')"
      @retry="retry"
    />

    <template v-else>
      <ShoppingListHeader :searching="searchOpen" @back="goBack" @toggle-search="toggleSearch" />

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
        <span class="text-weight-medium">{{ store.numericTotal }}</span>
      </div>

      <div v-if="visibleCount === 0" class="text-grey text-center q-my-lg">
        {{ query ? 'No items match your search.' : 'No items yet.' }}
      </div>
    </template>
  </q-page>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import draggable from 'vuedraggable'
import ShoppingListHeader from 'src/components/ShoppingListHeader.vue'
import ShoppingListRow from 'src/components/ShoppingListRow.vue'
import ShoppingListSaveStatus from 'src/components/ShoppingListSaveStatus.vue'
import ShoppingListUnavailable from 'src/components/ShoppingListUnavailable.vue'
import StaleDataNotice from 'src/components/StaleDataNotice.vue'
import { useRowRefs } from 'src/composables/useRowRefs'
import { useUndoRedoShortcuts } from 'src/composables/useUndoRedoShortcuts'
import { useFlushOnHide } from 'src/composables/useFlushOnHide'
import { useRetryWhenOnline } from 'src/composables/useRetryWhenOnline'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { isNetworkError } from 'src/api'

const route = useRoute()
const router = useRouter()
const store = useShoppingListsStore()

const query = ref('')
const searchOpen = ref(false)
const searchInput = ref(null)
const loadFailed = ref(false)
const loading = ref(false)

const { setRowRef, focusName, focusQty, regrowNames } = useRowRefs()

useUndoRedoShortcuts(store)
useFlushOnHide(store.flush)

// Toggling a column changes the name column's width, and Quasar's `autogrow` only
// re-measures on input — so re-measure whenever either toggle lands, including when it
// lands because a newer copy of the list arrived from the server.
watch([() => store.showQuantity, () => store.showCheckbox], regrowNames)

// With a quantity column, Enter is a move between the two fields of the same row — the
// name is only half of it. Without one, the name *is* the row, so Enter ends it and
// starts the next: the text after the caret goes down with it, and the caret follows,
// landing at the seam.
function onNameEnter(item, index, start, end) {
  if (store.showQuantity) {
    focusQty(item._key)
    return
  }
  // Close the open edit before the split records its own step, or the two land on the
  // undo stack in the order they were finished rather than the order they happened.
  store.endEdit()
  focusName(store.splitRow(index, start, end), 0)
}

// The other direction, and only where Enter splits: Backspace from the start of a name
// takes the row up into the one above, leaving the caret on the seam. A row with a
// quantity is more than its name, so joining two of them would quietly drop one — there
// the key stays an ordinary delete.
function onNameBackspace(index) {
  if (store.showQuantity) return
  store.endEdit()
  const joined = store.mergeRowUp(index)
  if (joined) focusName(joined.key, joined.caret)
}

// ---- search ----
//
// Closing clears the query as well as the field. A filter left running behind a folded
// box would be invisible: rows missing from the list, "Add item" disabled, and nothing on
// screen saying why.
function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) nextTick(() => searchInput.value?.focus())
  else query.value = ''
}

function matchesQuery(item) {
  const q = (query.value || '').trim().toLowerCase()
  return !q || item.name.toLowerCase().includes(q)
}
const visibleCount = computed(() => store.items.filter(matchesQuery).length)

async function goBack() {
  await store.flush()
  router.push('/')
}

// ---- opening a list ----
//
// The store owns the switch itself — firing the outgoing list's pending save, resetting
// its history, and either serving the new list from cache or fetching it. All this page
// decides is where a failure sends the user.
async function openList(id) {
  loadFailed.value = false
  loading.value = true
  try {
    focusName(await store.open(id))
  } catch (err) {
    // Two very different failures land here. A response — 404, or 403 for someone
    // else's list — is the server's final word, and bouncing home is right. A
    // transport failure is not a verdict on the list: offline it is simply
    // unreachable for now, and ejecting would send the user to a home page that
    // cannot load either, i.e. the list becomes unopenable rather than merely stale.
    if (!isNetworkError(err)) {
      router.replace('/')
      return
    }
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

function retry() {
  if (!loading.value) openList(route.params.id)
}

// Started here rather than in onMounted so a cached list is already on screen at the
// first render, with no empty frame in between.
openList(route.params.id)

// vue-router reuses this component for /list/1 -> /list/2, so onMounted does not
// run again — without this, switching lists would keep showing the old one.
watch(() => route.params.id, openList)

// Two cases, and only these two. A list we could not reach at all is worth opening again;
// one that opened from cache and was never confirmed is worth asking about again, which is
// also the only thing that can retire the "not connected" notice above it. A list that
// opened normally needs neither just because the connection blinked.
useRetryWhenOnline(() => {
  if (loadFailed.value) retry()
  else if (store.stale) store.refreshOpen()
})

// The debounced save outlives this page, so a pending one has to be fired on the way out
// rather than left on a timer that nothing will reach.
onBeforeUnmount(store.stopSaving)
</script>
