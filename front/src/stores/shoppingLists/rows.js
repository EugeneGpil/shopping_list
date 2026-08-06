/**
 * Every change to the open list's rows. Components call these by row index — they hold
 * no row objects of their own, so there is no way to edit a row without going through
 * an action that keeps history and the save in step.
 *
 * The insert helpers return the new row's key so the caller can move focus to it —
 * focus is a DOM concern and stays in the page.
 */
export function createRows({ current, record, scheduleSave }) {
  // Row keys only have to be unique within the session, and are deliberately NOT reset
  // per list: a stale key from another list can then never collide with a new row in
  // the page's ref map.
  let keySeq = 0
  const nextKey = () => ++keySeq

  function createRow(fields = {}) {
    return { name: '', quantity: '', checked: false, ...fields, _key: nextKey() }
  }

  /** The open list's rows, or null when nothing is open or nothing is loaded yet. */
  const rows = () => current.value?.items ?? null
  const rowAt = (index) => rows()?.[index] ?? null

  // ---- editing a row ----
  //
  // Typing does not schedule a save, and this is on purpose: the edit is committed when
  // the field reports `change` (i.e. on blur), which is where `endEdit` pushes the one
  // undo step for it and schedules the save. Saving per keystroke would both hammer the
  // endpoint and break "one edit, one undo step".

  function setName(index, value) {
    const row = rowAt(index)
    if (row) row.name = value ?? ''
  }

  /**
   * Quantities are positive integers, or "" for none. Returns the stored string so the
   * caller can put a sanitized value back into the DOM when the model did not change.
   */
  function setQuantity(index, value) {
    const row = rowAt(index)
    const digits = String(value ?? '')
      .replace(/[^0-9]/g, '')
      .replace(/^0+/, '')
    if (row) row.quantity = digits
    return digits
  }

  // Checking a box is a complete edit on its own — no blur to wait for.
  function toggleChecked(index, value) {
    const row = rowAt(index)
    if (!row) return
    record()
    row.checked = !!value
    scheduleSave()
  }

  // ---- adding and removing ----

  /**
   * Keep at least one (empty) row so there is always somewhere to start typing.
   * Returns the new row's key if one was added, else null.
   */
  function ensureRow() {
    const list = rows()
    if (!list || list.length) return null
    const row = createRow()
    list.push(row)
    scheduleSave()
    return row._key
  }

  /** Returns the new row's key so the caller can move focus to it. */
  function insertRow(index) {
    const list = rows()
    if (!list) return null
    record()
    const row = createRow()
    list.splice(index, 0, row)
    scheduleSave()
    return row._key
  }

  const addRow = () => insertRow(rows()?.length ?? 0)
  const addRowAfter = (index) => insertRow(index + 1)

  function removeRow(index) {
    const list = rows()
    if (!list || !list[index]) return
    record()
    list.splice(index, 1)
    ensureRow()
    scheduleSave()
  }

  /**
   * Take a reordered array from the drag handle. The snapshot for undo is taken by
   * `beginDrag` and committed by `endDrag`, so this only swaps the array in.
   */
  function reorder(ordered) {
    if (current.value) current.value.items = ordered
  }

  return {
    createRow,
    ensureRow,
    setName,
    setQuantity,
    toggleChecked,
    addRow,
    addRowAfter,
    removeRow,
    reorder,
  }
}
