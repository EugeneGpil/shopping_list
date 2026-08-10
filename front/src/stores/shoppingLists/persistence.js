const SAVE_DEBOUNCE = 700

/**
 * The strings shown in the save indicator. Defined here because this module owns
 * reporting; kept in one place so the UI can tell the states apart by identity instead of
 * re-typing the wording.
 */
export const SAVE_STATUS = {
  saving: 'Saving…',
  saved: 'Saved',
  // Not a failure: the edit is safe locally and will go up on its own. Saying "failed"
  // here is what makes an offline app feel broken when it is working as designed.
  offline: 'Saved on this device',
  failed: 'Save failed',
  conflict: 'Replaced by a newer version',
}

/** What `pushList` reports, in the words the user sees. */
const OUTCOME_STATUS = {
  saved: SAVE_STATUS.saved,
  offline: SAVE_STATUS.offline,
  // Encrypted, and the key is not back yet. The edit is kept exactly as an offline one is,
  // and goes up after the unlock — so it gets the same words, which are already true.
  locked: SAVE_STATUS.offline,
  failed: SAVE_STATUS.failed,
  conflict: SAVE_STATUS.conflict,
}

/**
 * The local write path for the open list: mark it dirty, debounce, hand it to `pushList`.
 *
 * The debounce is what collapses a burst of typing into one request; the endpoint replaces
 * the full item set on every PUT, so there is never more than one request to make. Nothing
 * here fails — `pushList` reports what happened and the worst case is that the change
 * stays local until `sync` gets another chance.
 *
 * Owns the debounce timer. Nothing else may touch it.
 */
export function createPersistence({
  current,
  openId,
  saveStatus,
  isLoaded,
  touch,
  markDirty,
  pushList,
}) {
  let saveTimer = null
  let pendingSave = false

  function scheduleSave() {
    if (!isLoaded()) return
    touch()
    markDirty()
    pendingSave = true
    saveStatus.value = SAVE_STATUS.saving
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, SAVE_DEBOUNCE)
  }

  /** Push the open list now. Also the entry point for the settings, which are not debounced. */
  async function save() {
    clearTimeout(saveTimer)
    pendingSave = false
    // Capture the record up front: the page may navigate away mid-flight, and this save
    // still belongs to the list it was queued for.
    const record = current.value
    if (!record) return
    markDirty()
    saveStatus.value = SAVE_STATUS.saving
    report(record.id, OUTCOME_STATUS[await pushList(record)])
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

  return { scheduleSave, save, flush, stopSaving, reset }
}
