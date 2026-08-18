import { createRow } from './record'

/**
 * Group digits in threes with `_`, which is the separator the total already reads back:
 * 1000000 becomes "1_000_000". The sign sits outside the grouping, so -1000000 becomes
 * "-1_000_000" and stays a number to `numericTotal`.
 */
export function withSeparators(n) {
  const sign = n < 0 ? '-' : ''
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+$)/g, '_')
}

/**
 * Every change to the open list's rows. Components call these by row index — they hold
 * no row objects of their own, so there is no way to edit a row without going through
 * an action that keeps history and the save in step.
 *
 * The insert helpers return the new row's key so the caller can move focus to it —
 * focus is a DOM concern and stays in the page.
 */
export default {
  _rowAt(index) {
    return this._rowList()?.[index] ?? null
  },

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

  setName(index, value) {
    const row = this._rowAt(index)
    if (!row) return
    row.name = value ?? ''
    this._markDirty()
  },

  /**
   * Quantities are positive integers, or "" for none. Returns the stored string so the
   * caller can put a sanitized value back into the DOM when the model did not change.
   */
  setQuantity(index, value) {
    const row = this._rowAt(index)
    const digits = String(value ?? '')
      .replace(/[^0-9]/g, '')
      .replace(/^0+/, '')
    if (row) {
      row.quantity = digits
      this._markDirty()
    }
    return digits
  },

  // Checking a box is a complete edit on its own — no blur to wait for.
  toggleChecked(index, value) {
    const row = this._rowAt(index)
    if (!row) return
    this._record()
    row.checked = !!value
    this._scheduleSave()
  },

  // ---- adding and removing ----

  /**
   * Keep at least one (empty) row so there is always somewhere to start typing.
   * Returns the new row's key if one was added, else null.
   */
  _ensureRow() {
    const list = this._rowList()
    if (!list || list.length) return null
    const row = createRow()
    list.push(row)
    this._scheduleSave()
    return row._key
  },

  /** Returns the new row's key so the caller can move focus to it. */
  _insertRow(index) {
    const list = this._rowList()
    if (!list) return null
    this._record()
    const row = createRow()
    list.splice(index, 0, row)
    this._scheduleSave()
    return row._key
  },

  addRow() {
    return this._insertRow(this._rowList()?.length ?? 0)
  },

  addRowAfter(index) {
    return this._insertRow(index + 1)
  },

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
  splitRow(index, start, end) {
    const list = this._rowList()
    const row = this._rowAt(index)
    if (!row) return null
    const text = row.name ?? ''
    const at = (n) => (n == null ? text.length : Math.max(0, Math.min(n, text.length)))
    const from = at(start)
    const to = at(end ?? start)
    this._record()
    row.name = text.slice(0, Math.min(from, to))
    const next = createRow({ name: text.slice(Math.max(from, to)) })
    list.splice(index + 1, 0, next)
    this._scheduleSave()
    return next._key
  },

  /**
   * The inverse of `splitRow`: take a row up into the one above it, the way Backspace at
   * the start of a line joins it to the line before. Undoes a split exactly, and joins two
   * rows that were never split apart just the same.
   *
   * The row above keeps its own quantity and tick — it is still that item, only its text
   * grew. Whatever the row being absorbed carried is dropped with the row, as it would be
   * on a delete.
   *
   * Returns the row above's key and the offset the join landed at, so the caller can put
   * the caret on the seam; null when there is no row above to join.
   */
  mergeRowUp(index) {
    const list = this._rowList()
    const row = this._rowAt(index)
    const above = this._rowAt(index - 1)
    if (!list || !row || !above) return null
    this._record()
    const caret = (above.name ?? '').length
    above.name = (above.name ?? '') + (row.name ?? '')
    list.splice(index, 1)
    this._scheduleSave()
    return { key: above._key, caret }
  },

  /**
   * Collapse a list that has been added up into its answer: every row goes, one row with
   * the total takes their place. The counting is done at that point and the rows are
   * working notes — this is the "= 1_000_000" line you would write under a column of
   * figures, except it replaces the column instead of growing it.
   *
   * Only ever available where the total is (see `numericTotal`), so there is no case where
   * this could throw away rows it could not add up. It is one undo step like any other
   * edit, which is what makes it safe to offer for a whole list at once.
   *
   * Returns the new row's key, or null when there was no total to squash to.
   */
  squashRows() {
    const list = this._rowList()
    const total = this.numericTotal
    if (!list || total === null) return null
    this._record()
    const row = createRow({ name: withSeparators(total) })
    list.splice(0, list.length, row)
    this._scheduleSave()
    return row._key
  },

  removeRow(index) {
    const list = this._rowList()
    if (!list || !list[index]) return
    this._record()
    list.splice(index, 1)
    this._ensureRow()
    this._scheduleSave()
  },

  /**
   * Take a reordered array from the drag handle. The snapshot for undo is taken by
   * `beginDrag` and committed by `endDrag`, so this only swaps the array in.
   */
  reorder(ordered) {
    if (this.current) this.current.items = ordered
  },
}
