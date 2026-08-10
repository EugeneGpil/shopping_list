/**
 * Per-list settings: the list name, the two column toggles, and whether the list is
 * encrypted. Saved immediately rather than debounced — each is a deliberate single act, not
 * a stream of keystrokes.
 *
 * No network code of its own: it edits the record and calls the same `save()` the rows use,
 * so a toggle flipped offline sticks and syncs later like everything else. That is a change
 * from the version before offline support, which reverted the toggle when the request
 * failed — with a queue behind it, reverting would be throwing away a change we can keep.
 *
 * Owns the pre-edit name snapshot, which is only used to reject an empty title.
 */
export function createSettings({ current, save }) {
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
    // A list with no name is not a state worth keeping, so this is the one revert left.
    if (!name) {
      record.name = nameSnapshot
      return
    }
    record.name = name
    if (name === nameSnapshot) return
    nameSnapshot = name
    await save()
  }

  // The record's field names are the API's field names, so the toggle needs nothing but
  // the field it flips.
  async function toggleColumn(field) {
    const record = current.value
    if (!record) return
    record[field] = !record[field]
    await save()
  }

  const toggleQuantity = () => toggleColumn('show_quantity')
  const toggleCheckbox = () => toggleColumn('show_checkbox')

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
  async function setEncrypted(value) {
    const record = current.value
    if (!record || !!record.encrypted === value) return
    record.encrypted = value
    await save()
  }

  function reset() {
    nameSnapshot = ''
  }

  return {
    setListName,
    beginNameEdit,
    saveName,
    toggleQuantity,
    toggleCheckbox,
    setEncrypted,
    reset,
  }
}
