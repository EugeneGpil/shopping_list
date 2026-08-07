import { createRow } from './record'

/**
 * Every change to the open list's rows. Components call these by row index — they hold
 * no row objects of their own, so there is no way to edit a row without going through
 * an action that keeps history and the save in step.
 *
 * The insert helpers return the new row's key so the caller can move focus to it —
 * focus is a DOM concern and stays in the page.
 */
export function createRows({ current, record, scheduleSave, markDirty }) {
  /** The open list's rows, or null when nothing is open or nothing is loaded yet. */
  const rows = () => current.value?.items ?? null
  const rowAt = (index) => rows()?.[index] ?? null

  // ---- editing a row ----
  //
  // Typing does not schedule a save, and this is on purpose: the edit is committed when
  // the field reports `change` (i.e. on blur), which is where `endEdit` pushes the one
  // undo step for it and schedules the save. Saving per keystroke would both hammer the
  // endpoint and break "one edit, one undo step".
  //
  // It does mark the list dirty though. Every keystroke is already mirrored to
  // localStorage, so a phone killed before the blur keeps the text — and without the flag
  // the next launch would hold text it never intends to push.

  function setName(index, value) {
    const row = rowAt(index)
    if (!row) return
    row.name = value ?? ''
    markDirty()
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
    if (row) {
      row.quantity = digits
      markDirty()
    }
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

  /**
   * Break a row in two at the caret, the way Enter breaks a line in any editor: what sits
   * after the caret becomes a new row below, what sits before it stays. So Enter at the
   * end of the text leaves an empty row below, Enter at the start pushes the whole text
   * down, and Enter mid-text splits it — one rule, all three cases.
   *
   * `start`/`end` are the field's selection: a selection is dropped rather than
   * duplicated, which is what typing over it would do.
   *
   * Quantity and checkbox are not carried over — the new row is a new item, and inheriting
   * "2" or a tick from the row it was cut out of would be a claim about it that the user
   * never made.
   *
   * Returns the new row's key so the caller can move the caret into it.
   */
  function splitRow(index, start, end) {
    const list = rows()
    const row = rowAt(index)
    if (!row) return null
    const text = row.name ?? ''
    const at = (n) => (n == null ? text.length : Math.max(0, Math.min(n, text.length)))
    const from = at(start)
    const to = at(end ?? start)
    record()
    row.name = text.slice(0, Math.min(from, to))
    const next = createRow({ name: text.slice(Math.max(from, to)) })
    list.splice(index + 1, 0, next)
    scheduleSave()
    return next._key
  }

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
    ensureRow,
    setName,
    setQuantity,
    toggleChecked,
    addRow,
    addRowAfter,
    splitRow,
    removeRow,
    reorder,
  }
}
