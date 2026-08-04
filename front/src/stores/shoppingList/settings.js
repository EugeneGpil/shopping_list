import { api } from 'src/api'

/**
 * Per-list settings that are saved immediately rather than debounced: the list
 * name and the two column toggles. Each is a single small PUT, and each reverts
 * the local value if the request fails.
 *
 * Owns the pre-edit name snapshot used to revert.
 */
export function createSettings({
  listId,
  listName,
  showQuantity,
  showCheckbox,
  saveStatus,
  report,
}) {
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
    const id = listId.value
    saveStatus.value = 'Saving…'
    try {
      await api.put(`shopping-list?list_id=${id}`, { name })
      report(id, 'Saved')
    } catch {
      listName.value = nameSnapshot
      report(id, 'Save failed')
    }
  }

  async function toggleColumn(flag, field) {
    flag.value = !flag.value
    const id = listId.value
    saveStatus.value = 'Saving…'
    try {
      await api.put(`shopping-list?list_id=${id}`, { [field]: flag.value })
      report(id, 'Saved')
    } catch {
      flag.value = !flag.value
      report(id, 'Save failed')
    }
  }

  const toggleQuantity = () => toggleColumn(showQuantity, 'show_quantity')
  const toggleCheckbox = () => toggleColumn(showCheckbox, 'show_checkbox')

  function reset() {
    nameSnapshot = ''
  }

  return { beginNameEdit, saveName, toggleQuantity, toggleCheckbox, reset }
}
