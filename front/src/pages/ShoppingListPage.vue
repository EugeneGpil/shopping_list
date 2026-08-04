<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <ShoppingListHeader
      v-model:name="listName"
      :show-quantity="showQuantity"
      :show-checkbox="showCheckbox"
      :can-undo="canUndo"
      :can-redo="canRedo"
      @name-focus="beginNameEdit"
      @name-change="saveName"
      @back="goBack"
      @toggle-quantity="toggleQuantity"
      @toggle-checkbox="toggleCheckbox"
      @undo="undo"
      @redo="redo"
    />

    <div class="text-caption text-grey q-mb-sm" style="height: 16px">
      {{ saveStatus }}
    </div>

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

    <!-- Column headers -->
    <div class="row items-center text-caption text-grey q-mb-xs">
      <div style="width: 32px" />
      <div v-if="showCheckbox" style="width: 32px" />
      <div class="col">Name</div>
      <div v-if="showQuantity" style="width: 56px; text-align: center">Qty</div>
      <div style="width: 20px" />
    </div>

    <!-- Rows -->
    <draggable
      v-model="items"
      item-key="_key"
      handle=".drag-handle"
      :animation="150"
      :disabled="!!query"
      :force-fallback="true"
      class="q-list q-list--bordered q-list--separator rounded-borders"
      @start="beginDrag"
      @end="endDrag"
    >
      <template #item="{ element: item }">
        <ShoppingListRow
          v-show="matchesQuery(item)"
          :ref="(el) => setRowRef(item._key, el)"
          :item="item"
          :show-quantity="showQuantity"
          :show-checkbox="showCheckbox"
          :searching="!!query"
          @update:name="(v) => (item.name = v)"
          @update:quantity="(v) => (item.quantity = v)"
          @toggle-checked="(v) => toggleChecked(item, v)"
          @edit-start="beginEdit"
          @edit-end="endEdit"
          @name-enter="onNameEnter(item)"
          @qty-enter="addRowAfter(item)"
          @remove="removeRow(item)"
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
      @click="addRow"
    >
      <q-tooltip v-if="query">Clear the search to add items</q-tooltip>
    </q-btn>

    <div v-if="visibleCount === 0" class="text-grey text-center q-my-lg">
      {{ query ? 'No items match your search.' : 'No items yet.' }}
    </div>
  </q-page>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import draggable from 'vuedraggable'
import { api } from 'src/api'
import ShoppingListHeader from 'src/components/ShoppingListHeader.vue'
import ShoppingListRow from 'src/components/ShoppingListRow.vue'
import { useListHistory } from 'src/composables/useListHistory'
import { useListSave } from 'src/composables/useListSave'

const route = useRoute()
const router = useRouter()
const listId = route.params.id

const listName = ref('')
const showQuantity = ref(true)
const showCheckbox = ref(true)
const items = ref([])
const query = ref('')

const { saveStatus, scheduleSave, flush, markLoaded, stop: stopSaving } = useListSave(listId, items)
const { canUndo, canRedo, record, undo, redo, beginEdit, endEdit, beginDrag, endDrag } =
  useListHistory(items, scheduleSave)

let keySeq = 0
const nextKey = () => ++keySeq

// per-row component refs, to move focus and re-measure row heights programmatically
const rowRefs = new Map()
function setRowRef(key, el) {
  if (el) rowRefs.set(key, el)
  else rowRefs.delete(key)
}
function focusName(key) {
  nextTick(() => rowRefs.get(key)?.focusName())
}
function focusQty(key) {
  nextTick(() => rowRefs.get(key)?.focusQty())
}
function regrowNames() {
  nextTick(() => {
    for (const row of rowRefs.values()) row?.regrow()
  })
}

// ---- list name editing ----
let nameSnapshot = ''
function beginNameEdit() {
  nameSnapshot = listName.value
}
async function saveName() {
  const name = listName.value.trim()
  if (!name) {
    listName.value = nameSnapshot
    return
  }
  listName.value = name
  if (name === nameSnapshot) return
  saveStatus.value = 'Saving…'
  try {
    await api.put(`shopping-list?list_id=${listId}`, { name })
    saveStatus.value = 'Saved'
  } catch {
    listName.value = nameSnapshot
    saveStatus.value = 'Save failed'
  }
}

// ---- column visibility (per-list, persisted) ----
async function toggleColumn(flag, field) {
  flag.value = !flag.value
  regrowNames()
  saveStatus.value = 'Saving…'
  try {
    await api.put(`shopping-list?list_id=${listId}`, { [field]: flag.value })
    saveStatus.value = 'Saved'
  } catch {
    flag.value = !flag.value
    regrowNames()
    saveStatus.value = 'Save failed'
  }
}
const toggleQuantity = () => toggleColumn(showQuantity, 'show_quantity')
const toggleCheckbox = () => toggleColumn(showCheckbox, 'show_checkbox')

// ---- keyboard flow ----
function onNameEnter(item) {
  if (showQuantity.value) focusQty(item._key)
  else addRowAfter(item)
}

// ---- mutations ----
function toggleChecked(item, value) {
  record()
  item.checked = !!value
  scheduleSave()
}
// Keep at least one (empty) row so there is always somewhere to start typing.
function ensureRow(focus = false) {
  if (items.value.length === 0) {
    const row = { name: '', quantity: '', checked: false, _key: nextKey() }
    items.value.push(row)
    scheduleSave()
    if (focus) focusName(row._key)
  }
}
function insertRow(index) {
  record()
  const row = { name: '', quantity: '', checked: false, _key: nextKey() }
  items.value.splice(index, 0, row)
  scheduleSave()
  focusName(row._key)
}
function addRowAfter(item) {
  insertRow(items.value.indexOf(item) + 1)
}
function addRow() {
  insertRow(items.value.length)
}
function removeRow(item) {
  const idx = items.value.indexOf(item)
  if (idx === -1) return
  record()
  items.value.splice(idx, 1)
  ensureRow()
  scheduleSave()
}

// ---- search ----
function matchesQuery(item) {
  const q = (query.value || '').trim().toLowerCase()
  return !q || item.name.toLowerCase().includes(q)
}
const visibleCount = computed(() => items.value.filter(matchesQuery).length)

async function goBack() {
  await flush()
  router.push('/')
}

function onKey(e) {
  if (!(e.ctrlKey || e.metaKey)) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault()
    undo()
  } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
    e.preventDefault()
    redo()
  }
}

onMounted(async () => {
  try {
    const { data } = await api.get(`shopping-list?list_id=${listId}`)
    listName.value = data.name
    showQuantity.value = data.show_quantity ?? true
    showCheckbox.value = data.show_checkbox ?? true
    items.value = data.items.map((i) => ({
      name: i.name,
      quantity: i.quantity ?? '',
      checked: !!i.checked,
      _key: nextKey(),
    }))
    markLoaded()
    ensureRow(true)
  } catch {
    // not found / not owned -> bounce home
    router.replace('/')
    return
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', regrowNames)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', regrowNames)
  stopSaving()
})
</script>
