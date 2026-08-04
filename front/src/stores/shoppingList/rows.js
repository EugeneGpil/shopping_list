/**
 * Adding, removing and checking rows.
 *
 * The insert helpers return the new row's key so the caller can move focus to it —
 * focus is a DOM concern and stays in the page.
 */
export function createRows({ items, record, scheduleSave }) {
  // Row keys only have to be unique within the session, and are deliberately NOT
  // reset along with the list: a stale key from a previously open list can then
  // never collide with a new row in the page's ref map.
  let keySeq = 0
  const nextKey = () => ++keySeq

  function createRow(fields = {}) {
    return { name: '', quantity: '', checked: false, ...fields, _key: nextKey() }
  }

  function toggleChecked(item, value) {
    record()
    item.checked = !!value
    scheduleSave()
  }

  /**
   * Keep at least one (empty) row so there is always somewhere to start typing.
   * Returns the new row's key if one was added, else null.
   */
  function ensureRow() {
    if (items.value.length) return null
    const row = createRow()
    items.value.push(row)
    scheduleSave()
    return row._key
  }

  /** Returns the new row's key so the caller can move focus to it. */
  function insertRow(index) {
    record()
    const row = createRow()
    items.value.splice(index, 0, row)
    scheduleSave()
    return row._key
  }

  const addRow = () => insertRow(items.value.length)
  const addRowAfter = (item) => insertRow(items.value.indexOf(item) + 1)

  function removeRow(item) {
    const idx = items.value.indexOf(item)
    if (idx === -1) return
    record()
    items.value.splice(idx, 1)
    ensureRow()
    scheduleSave()
  }

  return { createRow, ensureRow, addRow, addRowAfter, removeRow, toggleChecked }
}
