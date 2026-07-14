<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <!-- Header -->
    <div class="row items-center q-mb-sm no-wrap">
      <q-btn flat round dense icon="arrow_back" @click="goBack" />
      <q-input
        v-model="listName"
        dense
        borderless
        class="col q-ml-sm"
        input-class="text-h6 text-weight-bold ellipsis"
        @focus="beginNameEdit"
        @change="saveName"
        @keydown.enter.prevent="onNameTitleEnter"
      />
      <q-space />
      <q-btn
        flat
        round
        dense
        icon="pin"
        :color="showQuantity ? 'primary' : 'grey'"
        @click="toggleQuantity"
      >
        <q-tooltip>{{ showQuantity ? 'Hide quantity' : 'Show quantity' }}</q-tooltip>
      </q-btn>
      <q-btn flat round dense icon="undo" :disable="!canUndo" @click="undo">
        <q-tooltip>Undo</q-tooltip>
      </q-btn>
      <q-btn flat round dense icon="redo" :disable="!canRedo" @click="redo">
        <q-tooltip>Redo</q-tooltip>
      </q-btn>
    </div>

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
      @start="onDragStart"
      @end="onDragEnd"
    >
      <template #item="{ element: item }">
        <q-item v-show="matchesQuery(item)" class="q-pl-none">
          <q-item-section side style="width: 32px; min-width: 32px" class="items-center">
            <q-icon
              name="drag_indicator"
              class="drag-handle"
              color="grey-6"
              :style="query ? 'opacity:0.3' : ''"
            />
          </q-item-section>
          <q-item-section>
            <q-input
              :ref="(el) => setRef('name', item._key, el)"
              v-model="item.name"
              dense
              borderless
              @focus="beginEdit"
              @change="endEdit"
              @keydown.enter.prevent="onNameEnter(item)"
            />
          </q-item-section>
          <q-item-section v-if="showQuantity" side style="width: 56px; min-width: 56px" class="col-auto">
            <q-input
              :ref="(el) => setRef('qty', item._key, el)"
              :model-value="item.quantity"
              dense
              borderless
              inputmode="numeric"
              input-class="text-center"
              @update:model-value="(v) => onQtyInput(item, v)"
              @keypress="onQtyKeypress"
              @focus="beginEdit"
              @change="endEdit"
              @keydown.enter.prevent="onQtyEnter(item)"
            />
          </q-item-section>
          <q-item-section side style="width: 20px; min-width: 20px" class="q-pl-none">
            <q-btn flat round dense size="sm" padding="none" tabindex="-1" icon="delete" color="negative" @click="removeRow(item)" />
          </q-item-section>
        </q-item>
      </template>
    </draggable>

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

const route = useRoute()
const router = useRouter()
const listId = route.params.id

const listName = ref('')
const showQuantity = ref(true)
const items = ref([])
const query = ref('')
const saveStatus = ref('')

let keySeq = 0
const nextKey = () => ++keySeq

// per-row input refs, so we can move focus programmatically
const refs = { name: new Map(), qty: new Map() }
function setRef(field, key, el) {
  if (el) refs[field].set(key, el)
  else refs[field].delete(key)
}
function focusField(field, key) {
  nextTick(() => refs[field].get(key)?.focus())
}

// ---- history (local only) ----
const past = ref([])
const future = ref([])
const canUndo = computed(() => past.value.length > 0)
const canRedo = computed(() => future.value.length > 0)

const clone = (arr) => arr.map((r) => ({ ...r }))
const serialize = (arr) =>
  JSON.stringify(arr.map((r) => ({ name: r.name, quantity: r.quantity })))

function pushHistory(snapshot) {
  past.value.push(snapshot)
  if (past.value.length > 100) past.value.shift()
  future.value = []
}
function record() {
  pushHistory(clone(items.value))
}

function undo() {
  if (!past.value.length) return
  future.value.push(clone(items.value))
  items.value = past.value.pop()
  scheduleSave()
}
function redo() {
  if (!future.value.length) return
  past.value.push(clone(items.value))
  items.value = future.value.pop()
  scheduleSave()
}

// snapshot on focus (pre-edit); commit on change if something changed
let editSnapshot = null
function beginEdit() {
  editSnapshot = clone(items.value)
}
function endEdit() {
  if (editSnapshot && serialize(editSnapshot) !== serialize(items.value)) {
    pushHistory(editSnapshot)
    scheduleSave()
  }
  editSnapshot = null
}

// ---- drag reorder ----
let dragSnapshot = null
function onDragStart() {
  dragSnapshot = clone(items.value)
}
function onDragEnd() {
  if (dragSnapshot && serialize(dragSnapshot) !== serialize(items.value)) {
    pushHistory(dragSnapshot)
    scheduleSave()
  }
  dragSnapshot = null
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
function onNameTitleEnter(e) {
  e.target.blur()
}

// ---- quantity visibility (per-list, persisted) ----
async function toggleQuantity() {
  showQuantity.value = !showQuantity.value
  saveStatus.value = 'Saving…'
  try {
    await api.put(`shopping-list?list_id=${listId}`, { show_quantity: showQuantity.value })
    saveStatus.value = 'Saved'
  } catch {
    showQuantity.value = !showQuantity.value
    saveStatus.value = 'Save failed'
  }
}

// ---- keyboard flow ----
function onNameEnter(item) {
  if (showQuantity.value) focusField('qty', item._key)
  else addRowAfter(item)
}
function onQtyEnter(item) {
  addRowAfter(item)
}

// quantity accepts positive integers only ("" allowed = no quantity)
function onQtyKeypress(e) {
  if (!/[0-9]/.test(e.key)) e.preventDefault()
}
function onQtyInput(item, value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '').replace(/^0+/, '')
  item.quantity = digits
  // force the DOM to reflect the sanitized value even when the model is unchanged
  // (e.g. pasting "abc" collapses to "" which equals the previous model value)
  nextTick(() => {
    const q = refs.qty.get(item._key)
    const el = q?.getNativeElement?.()
    if (el && el.value !== digits) el.value = digits
  })
}

// ---- mutations ----
// Keep at least one (empty) row so there is always somewhere to start typing.
function ensureRow(focus = false) {
  if (items.value.length === 0) {
    const row = { name: '', quantity: '', _key: nextKey() }
    items.value.push(row)
    scheduleSave()
    if (focus) focusField('name', row._key)
  }
}
function addRowAfter(item) {
  record()
  const idx = items.value.indexOf(item)
  const row = { name: '', quantity: '', _key: nextKey() }
  items.value.splice(idx + 1, 0, row)
  scheduleSave()
  focusField('name', row._key)
}
function removeRow(item) {
  const idx = items.value.indexOf(item)
  if (idx === -1) return
  record()
  items.value.splice(idx, 1)
  ensureRow()
  scheduleSave()
}

// ---- persistence (debounced) ----
let saveTimer = null
let loaded = false
let pendingSave = false

function scheduleSave() {
  if (!loaded) return
  pendingSave = true
  saveStatus.value = 'Saving…'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 700)
}
async function save() {
  clearTimeout(saveTimer)
  pendingSave = false
  const payload = items.value.map((r) => ({
    name: r.name.trim(),
    quantity: r.quantity?.trim() || null,
  }))
  try {
    await api.put(`shopping-list?list_id=${listId}`, { items: payload })
    saveStatus.value = 'Saved'
  } catch {
    saveStatus.value = 'Save failed'
  }
}
async function flush() {
  if (pendingSave) await save()
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
    items.value = data.items.map((i) => ({
      name: i.name,
      quantity: i.quantity ?? '',
      _key: nextKey(),
    }))
    loaded = true
    ensureRow(true)
  } catch {
    // not found / not owned -> bounce home
    router.replace('/')
    return
  }
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (pendingSave) save()
  clearTimeout(saveTimer)
})
</script>

<style scoped>
.drag-handle {
  cursor: grab;
}
.drag-handle:active {
  cursor: grabbing;
}
</style>
