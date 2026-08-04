import { ref, computed } from 'vue'

const clone = (arr) => arr.map((r) => ({ ...r }))
const serialize = (arr) =>
  JSON.stringify(arr.map((r) => ({ name: r.name, quantity: r.quantity, checked: r.checked })))

/**
 * Local-only undo/redo over a list of rows. Snapshots are whole-array copies:
 * the list is small and a save rewrites every row server-side anyway, so there
 * is nothing to gain from per-field diffs.
 *
 * `onChange` is called whenever the items array is mutated by this composable
 * (undo/redo) or when an edit is committed — wire it to the debounced save.
 */
export function useListHistory(items, onChange) {
  const past = ref([])
  const future = ref([])
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  function pushHistory(snapshot) {
    past.value.push(snapshot)
    if (past.value.length > 100) past.value.shift()
    future.value = []
  }

  /** Snapshot the current state before a mutation the caller is about to make. */
  function record() {
    pushHistory(clone(items.value))
  }

  function undo() {
    if (!past.value.length) return
    future.value.push(clone(items.value))
    items.value = past.value.pop()
    onChange()
  }
  function redo() {
    if (!future.value.length) return
    past.value.push(clone(items.value))
    items.value = future.value.pop()
    onChange()
  }

  /**
   * Snapshot/commit pair for edits that span several events: take a snapshot when
   * the field is focused, commit it on change only if something actually differs.
   * Used for typing (focus/change) and for drag reorder (start/end).
   */
  function createTransaction() {
    let snapshot = null
    return {
      begin() {
        snapshot = clone(items.value)
      },
      end() {
        if (snapshot && serialize(snapshot) !== serialize(items.value)) {
          pushHistory(snapshot)
          onChange()
        }
        snapshot = null
      },
    }
  }

  const edit = createTransaction()
  const drag = createTransaction()

  return {
    canUndo,
    canRedo,
    record,
    undo,
    redo,
    beginEdit: edit.begin,
    endEdit: edit.end,
    beginDrag: drag.begin,
    endDrag: drag.end,
  }
}
