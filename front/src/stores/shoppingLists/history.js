import { ref, computed } from 'vue'

const HISTORY_LIMIT = 100

const clone = (arr) => arr.map((r) => ({ ...r }))
const serialize = (arr) =>
  JSON.stringify(arr.map((r) => ({ name: r.name, quantity: r.quantity, checked: r.checked })))

/**
 * Local-only undo/redo over the open list's rows. Snapshots are whole-array copies: the
 * list is small and a save rewrites every row server-side anyway, so there is nothing to
 * gain from per-field diffs.
 *
 * Owns the stacks and the in-flight snapshots. The stacks belong to the list that is
 * open, so `reset()` runs on every list switch — a snapshot of list A must never be
 * restorable onto list B. `scheduleSave` is called whenever this module changes the
 * rows or commits an edit.
 */
export function createHistory({ current, scheduleSave, touch }) {
  const past = ref([])
  const future = ref([])
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  let editSnapshot = null
  let dragSnapshot = null

  const rows = () => current.value?.items ?? null

  function pushHistory(snapshot) {
    past.value.push(snapshot)
    if (past.value.length > HISTORY_LIMIT) past.value.shift()
    future.value = []
  }

  /** Snapshot the current rows before a mutation the caller is about to make. */
  function record() {
    const list = rows()
    if (!list) return
    touch()
    pushHistory(clone(list))
  }

  function undo() {
    if (!past.value.length || !current.value) return
    future.value.push(clone(rows()))
    current.value.items = past.value.pop()
    scheduleSave()
  }
  function redo() {
    if (!future.value.length || !current.value) return
    past.value.push(clone(rows()))
    current.value.items = future.value.pop()
    scheduleSave()
  }

  /** Commit a snapshot only if the rows actually changed while it was held. */
  function commit(snapshot) {
    const list = rows()
    if (snapshot && list && serialize(snapshot) !== serialize(list)) {
      pushHistory(snapshot)
      scheduleSave()
    }
  }

  // typing: snapshot on focus, commit on change
  function beginEdit() {
    const list = rows()
    if (!list) return
    // Focusing a field is the user taking the list over: from here on a background
    // refresh must not replace the rows under them.
    touch()
    editSnapshot = clone(list)
  }
  function endEdit() {
    commit(editSnapshot)
    editSnapshot = null
  }

  // drag reorder: same pair, driven by draggable's start/end
  function beginDrag() {
    const list = rows()
    if (!list) return
    touch()
    dragSnapshot = clone(list)
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
