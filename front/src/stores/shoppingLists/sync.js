import { Notify } from 'quasar'
import { api, isNetworkError } from 'src/api'
import { payloadOf, recordFromApi } from './record'
import { privates } from './privates'

/**
 * Pushing local state to the server: the one write path in the app.
 *
 * Every local change marks its record `dirty` and returns immediately, so the UI never
 * waits on the network. Getting it to the server is this module's problem, whether that
 * happens 700ms later on the debounce or three hours later when the phone finds wifi.
 *
 * There is no operation log. Because a save is a full-document PUT, "what to send" is
 * always just the record as it stands now — ten offline edits to one list collapse into
 * one request, and a retry can never replay a stale intermediate state. The only queue is
 * the three flags on each record: `dirty`, `pendingDelete`, and a null `serverId`.
 *
 * Conflicts: every PUT carries the version it was based on, and the server
 * answers 409 if another device has written since. The newer server copy wins and the
 * user is told — losing an edit silently is the one outcome worth interrupting for.
 *
 * Actions only, merged into the store in `index.js`; `syncing` is state there.
 */
export default {
  /**
   * Take the server's copy of a list, keeping this record's local identity.
   *
   * Async because the copy may be ciphertext and `recordFromApi` is the seam that opens it
   * (§4). Every caller must await it, or the record is read before it has been replaced.
   */
  async _adopt(record, data) {
    Object.assign(record, await recordFromApi(data), { id: record.id })
  },

  _reportConflict(record) {
    Notify.create({
      type: 'warning',
      multiLine: true,
      timeout: 8000,
      message: `"${record.name}" was changed on another device, so that newer version was kept and your offline changes to it were discarded.`,
    })
  },

  /**
   * The one save failure the user can do something about, so it says what to do.
   *
   * `_reportConflict`'s case exactly — an edit that is not reaching the server, where silence is
   * the worse bug — and the indicator cannot carry it: one line with no room for a list name,
   * and the row is what has to be found. Repeating costs nothing: the message is identical on
   * every pass and Quasar groups notifications by their content, so a list that stays too long
   * collects a badge rather than a stack of toasts.
   */
  _reportTooLong(err) {
    Notify.create({
      type: 'warning',
      multiLine: true,
      timeout: 8000,
      message: `Row ${err.rowNumber} of "${err.listName}" is too long to save encrypted, so that list is still only on this device. Shorten that row and it will sync.`,
    })
  },

  /**
   * Send one list, and say how it went.
   *
   * Returns what happened rather than throwing, because every caller wants to carry on:
   * 'saved' | 'conflict' | 'offline' | 'failed' | 'locked' | 'too-long'. With one exception, which
   * pre-dates this union: the `await this._adopt(...)` inside the 409 branch, where a winning copy
   * that will not decrypt rejects and that rejection escapes instead of becoming an outcome.
   *
   * **The reporting is here, not in `_save`, because this is where the outcome is known.** Only
   * the debounced per-list path used to report, so a record pushed by a pass — the offline queue
   * draining, any of `MainLayout`'s four triggers — left the indicator saying whatever the last
   * local save had said: "Saved on this device", indefinitely, about an edit that had reached the
   * server minutes ago. And the same silence covered a background *failure*, which is the half
   * worth the noise: a write the user is not told about is the worse bug, so a background
   * conflict or error is allowed to raise the banner for the list they are looking at.
   *
   * `_report` is what keeps that from being noise on every other push: it says nothing unless the
   * list is the one on screen, so a pass flushing twenty lists writes the indicator at most once.
   */
  async _pushList(record) {
    // Before anything is reported: a tombstoned list has nothing worth sending, `_pushDelete`
    // owns it from here, and saying "Saved" about a push that never happened would overwrite the
    // open list's status with an answer to a question nobody asked.
    if (!record || record.pendingDelete) return 'saved'

    const outcome = await this._sendList(record)
    this._report(record.id, outcome)

    return outcome
  },

  /**
   * The request itself, split out so `_pushList` has exactly one place to report from — the body
   * has seven ways of ending and repeating the call at each of them is how one gets forgotten.
   */
  async _sendList(record) {
    try {
      // Built once, before the create: the name goes out encrypted on both requests, and
      // building it twice would encrypt it under two IVs for no reason.
      const payload = await payloadOf(record)

      if (!record.serverId) {
        const { data } = await api.post('shopping-lists', {
          name: payload.name,
          // Without this the row is created as plaintext and only corrected by the PUT that
          // follows — a window in which a crash leaves ciphertext flagged as readable.
          ...(payload.encrypted ? { encrypted: true } : {}),
        })
        record.serverId = data.id
        record.version = data.version ?? null
      }
      const { data } = await api.put(`shopping-list?list_id=${record.serverId}`, {
        ...payload,
        base_version: record.version,
      })
      record.version = data.version ?? null
      record.items_count = (data.items ?? []).length
      // What the server now holds. Without this a record that was just encrypted would still
      // describe itself as plaintext until the next read.
      record.encrypted = !!data.encrypted
      record.dirty = false
      return 'saved'
    } catch (err) {
      // Encrypted list, no key yet — `payloadOf` refused rather than write plaintext over
      // it. The same shape as offline: the edit stays dirty and goes out after the unlock.
      if (err.name === 'EncryptionLockedError') return 'locked'
      // The same shape once more — nothing sent, the edit still here — except that this one
      // does not clear itself: no key is coming to release it, only a shorter row. So the user
      // is told which row, and the pass carries on, because one over-long row on one list says
      // nothing about the next list waiting to go out.
      if (err.name === 'FieldTooLongError') {
        this._reportTooLong(err)
        return 'too-long'
      }
      if (err.status === 409) {
        // The server sent the copy that won, so there is nothing more to ask it for.
        const winner = err.body?.data
        if (winner) await this._adopt(record, winner)
        else record.dirty = false // cannot adopt without it; stop trying to push over it
        this._reportConflict(record)
        return 'conflict'
      }
      if (err.status === 404) {
        // Deleted elsewhere while we were holding an edit for it.
        this._forget(record.id)
        return 'conflict'
      }
      // Offline: stay dirty and wait for the next trigger. A server error also stays
      // dirty — there is no reason to think the next attempt fails the same way.
      return isNetworkError(err) ? 'offline' : 'failed'
    }
  },

  /** Send one tombstone. Drops the record locally once the server agrees — or already has. */
  async _pushDelete(record) {
    if (!record) return 'saved'
    if (!record.serverId) {
      this._forget(record.id) // never existed there; the tombstone is complete
      return 'saved'
    }
    try {
      await api.del(`shopping-list?list_id=${record.serverId}`)
      this._forget(record.id)
      return 'saved'
    } catch (err) {
      if (err.status === 404) {
        this._forget(record.id) // already gone, which is what we wanted
        return 'saved'
      }
      return isNetworkError(err) ? 'offline' : 'failed'
    }
  },

  async _pushOrder() {
    // Only lists the server knows about can be ordered; a temp list takes its place in the
    // order on the sync after the one that creates it.
    const ids = this.lists.filter((l) => l.serverId && !l.pendingDelete).map((l) => l.serverId)
    try {
      await api.put('shopping-lists/order', { ids })
      this.orderDirty = false
      return 'saved'
    } catch (err) {
      return isNetworkError(err) ? 'offline' : 'failed'
    }
  },

  /**
   * Flush the queue, and hand back the pass that is doing it.
   *
   * Serialised without being droppable: a second call while one is running joins that pass
   * rather than starting a second one, so `await sync()` returns only when a pass has actually
   * finished — which is what `encryption.unlock()` and the trash's `fetch()` need before they
   * read the server back, and what a call that returned the moment it found the flag set would
   * only look like. The triggers in `MainLayout` do not await it at all, and that is where the
   * second call comes from.
   *
   * What it is not is a promise of an empty queue afterwards: a joined pass may have started
   * before the caller's own change was flagged, and any pass stops early on 'offline' or
   * 'locked'. Nothing is lost — the flags stay, and the next trigger takes them.
   */
  async sync() {
    const own = privates(this)
    if (own.syncPass) return own.syncPass

    own.syncPass = this._syncPass().finally(() => {
      own.syncPass = null
    })

    return own.syncPass
  },

  /**
   * The pass itself, in the order the API needs: tombstones first so a deleted list cannot be
   * recreated by a later push, then creates and edits, then the order — which can only be sent
   * once every list in it has a server id.
   */
  async _syncPass() {
    this.syncing = true
    try {
      for (const record of this.lists.filter((l) => l.pendingDelete)) {
        if ((await this._pushDelete(record)) === 'offline') return
      }
      for (const record of this.lists.filter((l) => l.dirty || !l.serverId)) {
        // 'locked' stops the pass for the same reason 'offline' does: every remaining
        // encrypted list would refuse in exactly the same way, and the unlock is what
        // starts it again. 'too-long' deliberately does not — it is one row on one list, and
        // stopping would strand every other pending edit behind it.
        if (['offline', 'locked'].includes(await this._pushList(record))) return
      }
      if (this.orderDirty) await this._pushOrder()
    } finally {
      this.syncing = false
    }
  },
}
