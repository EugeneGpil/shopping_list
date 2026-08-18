import { privates } from './privates'

const HISTORY_LIMIT = 100

const clone = (arr) => arr.map((r) => ({ ...r }))
const serialize = (arr) =>
  JSON.stringify(arr.map((r) => ({ name: r.name, quantity: r.quantity, checked: r.checked })))

/**
 * Local-only undo/redo over the open list's rows. Snapshots are whole-array copies: the
 * list is small and a save rewrites every row server-side anyway, so there is nothing to
 * gain from per-field diffs.
 *
 * The stacks are `_past`/`_future` in the store's state, which is what makes `canUndo` and
 * `canRedo` reactive; the two in-flight snapshots are not state and live in `privates`.
 * All of it belongs to the list that is open, so `_resetHistory()` runs on every list
 * switch — a snapshot of list A must never be restorable onto list B. `_scheduleSave` is
 * called whenever this module changes the rows or commits an edit.
 */
export default {
  _pushHistory(snapshot) {
    this._past.push(snapshot)
    if (this._past.length > HISTORY_LIMIT) this._past.shift()
    this._future = []
  },

  /** Snapshot the current rows before a mutation the caller is about to make. */
  _record() {
    const list = this._rowList()
    if (!list) return
    this._touch()
    this._pushHistory(clone(list))
  },

  undo() {
    if (!this._past.length || !this.current) return
    this._future.push(clone(this._rowList()))
    this.current.items = this._past.pop()
    this._scheduleSave()
  },

  redo() {
    if (!this._future.length || !this.current) return
    this._past.push(clone(this._rowList()))
    this.current.items = this._future.pop()
    this._scheduleSave()
  },

  /** Commit a snapshot only if the rows actually changed while it was held. */
  _commit(snapshot) {
    const list = this._rowList()
    if (snapshot && list && serialize(snapshot) !== serialize(list)) {
      this._pushHistory(snapshot)
      this._scheduleSave()
    }
  },

  // typing: snapshot on focus, commit on change
  beginEdit() {
    const list = this._rowList()
    if (!list) return
    // Focusing a field is the user taking the list over: from here on a background
    // refresh must not replace the rows under them.
    this._touch()
    privates(this).editSnapshot = clone(list)
  },

  endEdit() {
    const own = privates(this)
    this._commit(own.editSnapshot)
    own.editSnapshot = null
  },

  // drag reorder: same pair, driven by draggable's start/end
  beginDrag() {
    const list = this._rowList()
    if (!list) return
    this._touch()
    privates(this).dragSnapshot = clone(list)
  },

  endDrag() {
    const own = privates(this)
    this._commit(own.dragSnapshot)
    own.dragSnapshot = null
  },

  _resetHistory() {
    const own = privates(this)
    this._past = []
    this._future = []
    own.editSnapshot = null
    own.dragSnapshot = null
  },
}
