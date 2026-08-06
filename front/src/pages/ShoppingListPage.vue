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
      <ShoppingListHeader @back="goBack" />

      <!-- Search -->
      <q-input
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

      <ShoppingListSaveStatus />

      <!-- Rows -->
      <draggable
        v-model="store.items"
        item-key="_key"
        handle=".drag-handle"
        :animation="150"
        :disabled="!!query"
        :force-fallback="true"
        class="q-list q-list--bordered q-list--separator rounded-borders"
        @start="store.beginDrag"
        @end="store.endDrag"
      >
        <template #item="{ element: item }">
          <ShoppingListRow
            v-show="matchesQuery(item)"
            :ref="(el) => setRowRef(item._key, el)"
            :item="item"
            :show-quantity="store.showQuantity"
            :show-checkbox="store.showCheckbox"
            :searching="!!query"
            @update:name="(v) => (item.name = v)"
            @update:quantity="(v) => (item.quantity = v)"
            @toggle-checked="(v) => store.toggleChecked(item, v)"
            @edit-start="store.beginEdit"
            @edit-end="store.endEdit"
            @name-enter="onNameEnter(item)"
            @qty-enter="focusName(store.addRowAfter(item))"
            @remove="store.removeRow(item)"
          />
        </template>
      </draggable>

      <!-- A new row is always appended at the end, so while a search is filtering the
           list it would land out of view — disable it until the search is cleared. -->
      <q-btn
        flat
        dense
        no-caps
        icon="add"
        label="Add item"
        color="primary"
        class="full-width q-mt-sm"
        :disable="!!query"
        @click="focusName(store.addRow())"
      >
        <q-tooltip v-if="query">Clear the search to add items</q-tooltip>
      </q-btn>

      <div v-if="visibleCount === 0" class="text-grey text-center q-my-lg">
        {{ query ? 'No items match your search.' : 'No items yet.' }}
      </div>
    </template>
  </q-page>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import draggable from 'vuedraggable'
import ShoppingListHeader from 'src/components/ShoppingListHeader.vue'
import ShoppingListRow from 'src/components/ShoppingListRow.vue'
import ShoppingListSaveStatus from 'src/components/ShoppingListSaveStatus.vue'
import ShoppingListUnavailable from 'src/components/ShoppingListUnavailable.vue'
import { useRowRefs } from 'src/composables/useRowRefs'
import { useUndoRedoShortcuts } from 'src/composables/useUndoRedoShortcuts'
import { useFlushOnHide } from 'src/composables/useFlushOnHide'
import { useShoppingListStore } from 'src/stores/shoppingList'
import { isNetworkError } from 'src/api'

const route = useRoute()
const router = useRouter()
const store = useShoppingListStore()

const query = ref('')
const loadFailed = ref(false)
const loading = ref(false)

const { setRowRef, focusName, focusQty, regrowNames } = useRowRefs()

useUndoRedoShortcuts(store)
useFlushOnHide(store.flush)

// Toggling a column changes the name column's width, and Quasar's `autogrow` only
// re-measures on input — so re-measure whenever either toggle lands, including
// when a failed save reverts it.
watch([() => store.showQuantity, () => store.showCheckbox], regrowNames)

function onNameEnter(item) {
  if (store.showQuantity) focusQty(item._key)
  else focusName(store.addRowAfter(item))
}

// ---- search ----
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
async function openList(id) {
  // Switching straight from one list to another does not unmount this page, so the
  // outgoing list's debounced save has to be fired here or it would be dropped by
  // the reset below. `save()` captures its list id and payload synchronously.
  store.stopSaving()
  // reset() is synchronous, so the previously opened list is gone before anything
  // renders — the store outlives this page and would otherwise flash A's rows
  // while B is still loading.
  store.reset()
  loadFailed.value = false
  loading.value = true
  try {
    focusName(await store.load(id))
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

// Started here rather than in onMounted so the reset lands before the first render.
openList(route.params.id)

// vue-router reuses this component for /list/1 -> /list/2, so onMounted does not
// run again — without this, switching lists would keep showing the old one.
watch(() => route.params.id, openList)

// Coming back online is the exact moment a failed load can succeed, so take it without
// making the user press Retry. A no-op when the list did load.
function onOnline() {
  if (loadFailed.value) retry()
}

onMounted(() => window.addEventListener('online', onOnline))

onBeforeUnmount(() => {
  window.removeEventListener('online', onOnline)
  store.stopSaving()
})
</script>
