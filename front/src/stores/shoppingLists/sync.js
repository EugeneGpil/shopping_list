import { ref } from 'vue'
import { Notify } from 'quasar'
import { api, isNetworkError } from 'src/api'
import { payloadOf, recordFromApi } from './record'

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
 */
export function createSync({ lists, orderDirty, forget }) {
  const syncing = ref(false)

  /**
   * Take the server's copy of a list, keeping this record's local identity.
   *
   * Async because the copy may be ciphertext and `recordFromApi` is the seam that opens it
   * (§4). Every caller must await it, or the record is read before it has been replaced.
   */
  async function adopt(record, data) {
    Object.assign(record, await recordFromApi(data), { id: record.id })
  }

  function reportConflict(record) {
    Notify.create({
      type: 'warning',
      multiLine: true,
      timeout: 8000,
      message: `"${record.name}" was changed on another device, so that newer version was kept and your offline changes to it were discarded.`,
    })
  }

  /**
   * Send one list: create it first if it only exists here, then PUT the whole document.
   *
   * Returns what happened rather than throwing, because every caller wants to carry on:
   * 'saved' | 'conflict' | 'offline' | 'failed'.
   */
  async function pushList(record) {
    // A tombstoned list has nothing worth sending; `pushDelete` owns it from here.
    if (!record || record.pendingDelete) return 'saved'
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
      if (err.status === 409) {
        // The server sent the copy that won, so there is nothing more to ask it for.
        const winner = err.body?.data
        if (winner) await adopt(record, winner)
        else record.dirty = false // cannot adopt without it; stop trying to push over it
        reportConflict(record)
        return 'conflict'
      }
      if (err.status === 404) {
        // Deleted elsewhere while we were holding an edit for it.
        forget(record.id)
        return 'conflict'
      }
      // Offline: stay dirty and wait for the next trigger. A server error also stays
      // dirty — there is no reason to think the next attempt fails the same way.
      return isNetworkError(err) ? 'offline' : 'failed'
    }
  }

  /** Send one tombstone. Drops the record locally once the server agrees — or already has. */
  async function pushDelete(record) {
    if (!record) return 'saved'
    if (!record.serverId) {
      forget(record.id) // never existed there; the tombstone is complete
      return 'saved'
    }
    try {
      await api.del(`shopping-list?list_id=${record.serverId}`)
      forget(record.id)
      return 'saved'
    } catch (err) {
      if (err.status === 404) {
        forget(record.id) // already gone, which is what we wanted
        return 'saved'
      }
      return isNetworkError(err) ? 'offline' : 'failed'
    }
  }

  async function pushOrder() {
    // Only lists the server knows about can be ordered; a temp list takes its place in the
    // order on the sync after the one that creates it.
    const ids = lists.value.filter((l) => l.serverId && !l.pendingDelete).map((l) => l.serverId)
    try {
      await api.put('shopping-lists/order', { ids })
      orderDirty.value = false
      return 'saved'
    } catch (err) {
      return isNetworkError(err) ? 'offline' : 'failed'
    }
  }

  /**
   * Flush everything pending, in the order the API needs: tombstones first so a deleted
   * list cannot be recreated by a later push, then creates and edits, then the order —
   * which can only be sent once every list in it has a server id.
   *
   * Serialised: a second call while one is running is dropped, not queued, because the
   * running pass reads the records live and will pick up anything newer anyway.
   */
  async function sync() {
    if (syncing.value) return
    syncing.value = true
    try {
      for (const record of lists.value.filter((l) => l.pendingDelete)) {
        if ((await pushDelete(record)) === 'offline') return
      }
      for (const record of lists.value.filter((l) => l.dirty || !l.serverId)) {
        if ((await pushList(record)) === 'offline') return
      }
      if (orderDirty.value) await pushOrder()
    } finally {
      syncing.value = false
    }
  }

  return { syncing, sync, pushList, pushDelete, pushOrder, adopt, reportConflict }
}
