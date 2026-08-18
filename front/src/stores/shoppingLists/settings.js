import { privates } from './privates'

/**
 * Per-list settings: the list name, the two column toggles, and whether the list is
 * encrypted. Saved immediately rather than debounced — each is a deliberate single act, not
 * a stream of keystrokes.
 *
 * No network code of its own: it edits the record and calls the same `_save()` the rows use,
 * so a toggle flipped offline sticks and syncs later like everything else. That is a change
 * from the version before offline support, which reverted the toggle when the request
 * failed — with a queue behind it, reverting would be throwing away a change we can keep.
 *
 * Owns the pre-edit name snapshot in `privates`, which is only used to reject an empty title.
 */
export default {
  /** Live value while the title is being typed in; committed by `saveName`. */
  setListName(value) {
    if (this.current) this.current.name = value ?? ''
  },

  beginNameEdit() {
    privates(this).nameSnapshot = this.current?.name ?? ''
  },

  async saveName() {
    const own = privates(this)
    const record = this.current
    if (!record) return
    const name = record.name.trim()
    // A list with no name is not a state worth keeping, so this is the one revert left.
    if (!name) {
      record.name = own.nameSnapshot
      return
    }
    record.name = name
    if (name === own.nameSnapshot) return
    own.nameSnapshot = name
    await this._save()
  },

  // The record's field names are the API's field names, so the toggle needs nothing but
  // the field it flips.
  async _toggleColumn(field) {
    const record = this.current
    if (!record) return
    record[field] = !record[field]
    await this._save()
  },

  toggleQuantity() {
    return this._toggleColumn('show_quantity')
  },

  toggleCheckbox() {
    return this._toggleColumn('show_checkbox')
  },

  /**
   * Encrypt this list, or stop encrypting it — the third per-list setting, and the one that
   * rewrites the content rather than the chrome.
   *
   * Nothing special happens here, which is the whole point of keying the seam on the flag:
   * flip it, save, and `payloadOf` sends the items sealed or in the clear to match, with the
   * flag in the same request so the two cannot disagree.
   *
   * The caller must have a key in hand before turning this *on* — `payloadOf` refuses
   * otherwise, and the editor asks for the fingerprint first. Turning it off needs no key
   * beyond the one already used to read the rows that are about to be written back.
   */
  async setEncrypted(value) {
    const record = this.current
    if (!record || !!record.encrypted === value) return
    record.encrypted = value
    await this._save()
  },

  _resetSettings() {
    privates(this).nameSnapshot = ''
  },
}
