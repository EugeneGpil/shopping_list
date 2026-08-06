import { api } from 'src/api'
import { SAVE_STATUS } from './persistence'

/**
 * Per-list settings that are saved immediately rather than debounced: the list name and
 * the two column toggles. Each is a single small PUT, and each reverts the local value
 * if the request fails.
 *
 * The fields live on the list record, so a rename here is the same object the index
 * page renders — there is nothing to keep in sync.
 *
 * Owns the pre-edit name snapshot used to revert.
 */
export function createSettings({ current, openId, saveStatus, report }) {
  let nameSnapshot = ''

  /** Live value while the title is being typed in; committed by `saveName`. */
  function setListName(value) {
    if (current.value) current.value.name = value ?? ''
  }

  function beginNameEdit() {
    nameSnapshot = current.value?.name ?? ''
  }

  async function saveName() {
    const record = current.value
    if (!record) return
    const name = record.name.trim()
    if (!name) {
      record.name = nameSnapshot
      return
    }
    record.name = name
    if (name === nameSnapshot) return
    const id = openId.value
    saveStatus.value = SAVE_STATUS.saving
    try {
      await api.put(`shopping-list?list_id=${id}`, { name })
      report(id, SAVE_STATUS.saved)
    } catch {
      record.name = nameSnapshot
      report(id, SAVE_STATUS.failed)
    }
  }

  // The record's field names are the API's field names, so the toggle needs nothing but
  // the field it flips.
  async function toggleColumn(field) {
    const record = current.value
    if (!record) return
    const next = !record[field]
    record[field] = next
    const id = openId.value
    saveStatus.value = SAVE_STATUS.saving
    try {
      await api.put(`shopping-list?list_id=${id}`, { [field]: next })
      report(id, SAVE_STATUS.saved)
    } catch {
      record[field] = !next
      report(id, SAVE_STATUS.failed)
    }
  }

  const toggleQuantity = () => toggleColumn('show_quantity')
  const toggleCheckbox = () => toggleColumn('show_checkbox')

  function reset() {
    nameSnapshot = ''
  }

  return { setListName, beginNameEdit, saveName, toggleQuantity, toggleCheckbox, reset }
}
