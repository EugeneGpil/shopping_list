import { api } from 'src/api'

const SAVE_DEBOUNCE = 700

/**
 * Debounced save of the whole item list. The endpoint replaces the full item set
 * on every PUT, so there is no per-row request to make — pending edits collapse
 * into one call.
 *
 * Owns the debounce timer and the loaded flag. Nothing else may touch them; use
 * `markLoaded()` after the initial fetch and `reset()` when the list changes.
 */
export function createPersistence({ listId, items, saveStatus }) {
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
    saveTimer = setTimeout(save, SAVE_DEBOUNCE)
  }

  async function save() {
    clearTimeout(saveTimer)
    pendingSave = false
    // capture the target list and payload up front: the page may navigate away
    // mid-flight, and this save still belongs to the list it was queued for
    const id = listId.value
    const payload = items.value.map((r) => ({
      name: r.name.trim(),
      quantity: r.quantity?.trim() || null,
      checked: !!r.checked,
    }))
    try {
      await api.put(`shopping-list?list_id=${id}`, { items: payload })
      report(id, 'Saved')
    } catch {
      report(id, 'Save failed')
    }
  }

  /** Only report a result if that list is still the one on screen. */
  function report(id, status) {
    if (listId.value === id) saveStatus.value = status
  }

  /** Await any pending save — use before navigating away. */
  async function flush() {
    if (pendingSave) await save()
  }

  /** Teardown: fire a pending save without awaiting it, and drop the timer. */
  function stopSaving() {
    if (pendingSave) save()
    clearTimeout(saveTimer)
  }

  function reset() {
    clearTimeout(saveTimer)
    saveTimer = null
    pendingSave = false
    loaded = false
  }

  return { scheduleSave, save, flush, stopSaving, report, markLoaded, reset }
}
