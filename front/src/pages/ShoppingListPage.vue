<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
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

    <!-- Save feedback. Fixed rather than in the page flow, so it takes up no space and can
         never shift the list — which is also why `v-if` is safe here. -->
    <div
      v-if="store.saveStatus"
      class="save-status text-caption"
      :class="store.saveFailed ? 'save-status--failed text-negative' : 'text-grey'"
    >
      {{ store.saveStatus }}
    </div>

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
  </q-page>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import draggable from 'vuedraggable'
import ShoppingListHeader from 'src/components/ShoppingListHeader.vue'
import ShoppingListRow from 'src/components/ShoppingListRow.vue'
import { useShoppingListStore } from 'src/stores/shoppingList'

const route = useRoute()
const router = useRouter()
const store = useShoppingListStore()

const query = ref('')

// Row components are addressed by key so focus and height re-measurement can be
// driven from here — DOM concerns stay out of the store.
const rowRefs = new Map()
function setRowRef(key, el) {
  if (el) rowRefs.set(key, el)
  else rowRefs.delete(key)
}
function focusName(key) {
  if (key) nextTick(() => rowRefs.get(key)?.focusName())
}
function focusQty(key) {
  if (key) nextTick(() => rowRefs.get(key)?.focusQty())
}
function regrowNames() {
  nextTick(() => {
    for (const row of rowRefs.values()) row?.regrow()
  })
}

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

// An edit is only committed when the field loses focus, so typing and then closing the
// app — or just switching away from it — would otherwise discard the text with no hint
// that anything was unsaved. Blurring first runs the ordinary commit path (`change` ->
// `endEdit` -> scheduled save), so the edit also becomes one undo step exactly as it
// would have; `flush` then pushes it out instead of waiting on the debounce.
//
// `visibilitychange` is the signal that actually fires when a phone backgrounds or
// closes a PWA; `pagehide` covers a desktop tab close.
async function persistBeforeHide() {
  if (document.visibilityState !== 'hidden') return
  document.activeElement?.blur?.()
  await store.flush()
}

function onKey(e) {
  if (!(e.ctrlKey || e.metaKey)) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault()
    store.undo()
  } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
    e.preventDefault()
    store.redo()
  }
}

async function openList(id) {
  // Switching straight from one list to another does not unmount this page, so the
  // outgoing list's debounced save has to be fired here or it would be dropped by
  // the reset below. `save()` captures its list id and payload synchronously.
  store.stopSaving()
  // reset() is synchronous, so the previously opened list is gone before anything
  // renders — the store outlives this page and would otherwise flash A's rows
  // while B is still loading.
  store.reset()
  try {
    focusName(await store.load(id))
  } catch {
    // not found / not owned -> bounce home
    router.replace('/')
  }
}

// Started here rather than in onMounted so the reset lands before the first render.
openList(route.params.id)

// vue-router reuses this component for /list/1 -> /list/2, so onMounted does not
// run again — without this, switching lists would keep showing the old one.
watch(() => route.params.id, openList)

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', regrowNames)
  document.addEventListener('visibilitychange', persistBeforeHide)
  window.addEventListener('pagehide', persistBeforeHide)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', regrowNames)
  document.removeEventListener('visibilitychange', persistBeforeHide)
  window.removeEventListener('pagehide', persistBeforeHide)
  store.stopSaving()
})
</script>

<style scoped>
/* Out of the flow entirely: transient feedback should never move the list under the
   user's finger. The backdrop keeps it legible when it lands over a row. */
.save-status {
  position: fixed;
  right: 12px;
  bottom: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
  pointer-events: none;
}
/* A failure is the one state worth interrupting for: unlike "Saved" it does not clear
   itself, so give it weight and a tinted background rather than colour alone. */
.save-status--failed {
  font-weight: 500;
  background: #fdecee;
  box-shadow: 0 1px 4px rgba(193, 0, 21, 0.28);
}
</style>
