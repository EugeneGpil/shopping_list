import { ref, computed } from 'vue'

const HISTORY_LIMIT = 100

const clone = (arr) => arr.map((r) => ({ ...r }))
const serialize = (arr) =>
  JSON.stringify(arr.map((r) => ({ name: r.name, quantity: r.quantity, checked: r.checked })))

/**
 * Local-only undo/redo over the rows. Snapshots are whole-array copies: the list
 * is small and a save rewrites every row server-side anyway, so there is nothing
 * to gain from per-field diffs.
 *
 * Owns the stacks and the in-flight snapshots. `scheduleSave` is called whenever
 * this module changes the rows or commits an edit.
 */
export function createHistory({ items, scheduleSave }) {
  const past = ref([])
  const future = ref([])
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  let editSnapshot = null
  let dragSnapshot = null

  function pushHistory(snapshot) {
    past.value.push(snapshot)
    if (past.value.length > HISTORY_LIMIT) past.value.shift()
    future.value = []
  }

  /** Snapshot the current rows before a mutation the caller is about to make. */
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

  /** Commit a snapshot only if the rows actually changed while it was held. */
  function commit(snapshot) {
    if (snapshot && serialize(snapshot) !== serialize(items.value)) {
      pushHistory(snapshot)
      scheduleSave()
    }
  }

  // typing: snapshot on focus, commit on change
  function beginEdit() {
    editSnapshot = clone(items.value)
  }
  function endEdit() {
    commit(editSnapshot)
    editSnapshot = null
  }

  // drag reorder: same pair, driven by draggable's start/end
  function beginDrag() {
    dragSnapshot = clone(items.value)
  }
  function endDrag() {
    commit(dragSnapshot)
    dragSnapshot = null
  }

  function reset() {
    past.value = []
    future.value = []
    editSnapshot = null
    dragSnapshot = null
  }

  return {
    canUndo,
    canRedo,
    record,
    undo,
    redo,
    beginEdit,
    endEdit,
    beginDrag,
    endDrag,
    reset,
  }
}
