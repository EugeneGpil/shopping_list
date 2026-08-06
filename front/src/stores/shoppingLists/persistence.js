import { api } from 'src/api'

const SAVE_DEBOUNCE = 700

/**
 * The strings shown in the save indicator. Defined here because this module owns
 * reporting; `settings.js` reports through the same `report()`. Kept in one place so
 * the UI can tell a failure apart by identity instead of re-typing the wording.
 */
export const SAVE_STATUS = {
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Save failed',
}

/**
 * Debounced save of the open list's whole item set. The endpoint replaces the full set
 * on every PUT, so there is no per-row request to make — pending edits collapse into
 * one call.
 *
 * Owns the debounce timer. Nothing else may touch it.
 */
export function createPersistence({ current, openId, saveStatus, isLoaded, touch }) {
  let saveTimer = null
  let pendingSave = false

  function scheduleSave() {
    if (!isLoaded()) return
    touch()
    pendingSave = true
    saveStatus.value = SAVE_STATUS.saving
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, SAVE_DEBOUNCE)
  }

  async function save() {
    clearTimeout(saveTimer)
    pendingSave = false
    // Capture the target list and payload up front: the page may navigate away
    // mid-flight, and this save still belongs to the list it was queued for.
    const id = openId.value
    const payload = (current.value?.items ?? []).map((r) => ({
      name: r.name.trim(),
      quantity: r.quantity?.trim() || null,
      checked: !!r.checked,
    }))
    try {
      await api.put(`shopping-list?list_id=${id}`, { items: payload })
      report(id, SAVE_STATUS.saved)
    } catch {
      report(id, SAVE_STATUS.failed)
    }
  }

  /** Only report a result if that list is still the one on screen. */
  function report(id, status) {
    if (openId.value === id) saveStatus.value = status
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
  }

  return { scheduleSave, save, flush, stopSaving, report, reset }
}
