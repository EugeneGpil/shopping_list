import { ref } from 'vue'
import { api } from 'src/api'

/**
 * Debounced save of the whole item list. The endpoint replaces the full item set
 * on every PUT, so there is no per-row request to make — pending edits collapse
 * into one call.
 *
 * `saveStatus` is shared with the page so other writes (renaming the list,
 * toggling a column) can report through the same line.
 */
export function useListSave(listId, items) {
  const saveStatus = ref('')

  let saveTimer = null
  let pendingSave = false
  // nothing is saved until the initial GET has populated `items`, or the first
  // debounce would push an empty list over the top of real data
  let loaded = false

  function markLoaded() {
    loaded = true
  }

  function scheduleSave() {
    if (!loaded) return
    pendingSave = true
    saveStatus.value = 'Saving…'
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 700)
  }

  async function save() {
    clearTimeout(saveTimer)
    pendingSave = false
    const payload = items.value.map((r) => ({
      name: r.name.trim(),
      quantity: r.quantity?.trim() || null,
      checked: !!r.checked,
    }))
    try {
      await api.put(`shopping-list?list_id=${listId}`, { items: payload })
      saveStatus.value = 'Saved'
    } catch {
      saveStatus.value = 'Save failed'
    }
  }

  /** Await any pending save — use before navigating away. */
  async function flush() {
    if (pendingSave) await save()
  }

  /** Teardown: fire a pending save without awaiting it, and drop the timer. */
  function stop() {
    if (pendingSave) save()
    clearTimeout(saveTimer)
  }

  return { saveStatus, scheduleSave, save, flush, markLoaded, stop }
}
