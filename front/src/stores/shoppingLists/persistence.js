import { privates } from './privates'

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

/**
 * What `_pushList` reports, in the words the user sees. Read only by `_report`, so the mapping
 * and the strings it maps to stay in one file — `sync.js` reports an outcome and never has to
 * know how one is worded.
 */
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
 * The local write path for the open list: mark it dirty, debounce, hand it to `_pushList`.
 *
 * The debounce is what collapses a burst of typing into one request; the endpoint replaces
 * the full item set on every PUT, so there is never more than one request to make. Nothing
 * here fails — `_pushList` reports what happened and the worst case is that the change
 * stays local until `sync` gets another chance.
 *
 * The reporting call is in `_pushList` now, so a list pushed by a pass updates the indicator
 * exactly as one saved from the editor does.
 *
 * Owns the debounce timer, which lives in `privates`. Nothing else may touch it.
 */
export default {
  _scheduleSave() {
    if (!this.isLoaded) return
    const own = privates(this)
    this._touch()
    this._markDirty()
    own.pendingSave = true
    this.saveStatus = SAVE_STATUS.saving
    clearTimeout(own.saveTimer)
    own.saveTimer = setTimeout(() => this._save(), SAVE_DEBOUNCE)
  },

  /** Push the open list now. Also the entry point for the settings, which are not debounced. */
  async _save() {
    const own = privates(this)
    clearTimeout(own.saveTimer)
    own.pendingSave = false
    // Capture the record up front: the page may navigate away mid-flight, and this save
    // still belongs to the list it was queued for.
    const record = this.current
    if (!record) return
    this._markDirty()
    this.saveStatus = SAVE_STATUS.saving
    // No reporting here: `_pushList` does it, for this push and every other one.
    await this._pushList(record)
  },

  /**
   * Say what a push did, if that list is still the one on screen.
   *
   * The guard is what makes reporting from `_pushList` safe: a pass pushes every dirty list, and
   * the indicator belongs to the one the user is looking at. A background push of anything else
   * is silent.
   */
  _report(id, outcome) {
    // Falling back to `failed` rather than to nothing: an unmapped outcome would write
    // `undefined`, which hides the indicator entirely and reads as `saveFailed === false` — the
    // exact bug this reporting exists to fix, and silent. The neighbouring vocabularies are
    // wider than this map (`trash.js` answers 'queued'/'restored', its probe 'live'/'gone'), and
    // making every push report is the point, so the next one routed through here must be loud.
    if (this.openId === id) this.saveStatus = OUTCOME_STATUS[outcome] ?? SAVE_STATUS.failed
  },

  /** Await any pending save — use before navigating away. */
  async flush() {
    if (privates(this).pendingSave) await this._save()
  },

  /** Teardown: fire a pending save without awaiting it, and drop the timer. */
  stopSaving() {
    const own = privates(this)
    if (own.pendingSave) this._save()
    clearTimeout(own.saveTimer)
  },

  _resetPersistence() {
    const own = privates(this)
    clearTimeout(own.saveTimer)
    own.saveTimer = null
    own.pendingSave = false
  },
}
