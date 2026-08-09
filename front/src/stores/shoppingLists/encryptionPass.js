import { api, isNetworkError } from 'src/api'
import { isUnlocked } from './encryption'
import { recordFromApi } from './record'

/**
 * Rewriting every list as ciphertext — the long half of "turn encryption on" (§6).
 *
 * The passkey registration and the wrapped key are the other half and happen before this; by
 * the time this runs the device holds a DEK and the only work left is one write per list.
 *
 * **It is a job, not a transaction.** Twenty-five lists is twenty-five requests and any of them
 * can be the last one before a tunnel, so this is built to stop cleanly and be run again rather
 * than to finish or roll back. Two things make that safe, and both live elsewhere:
 *
 *   - each list's `encrypted` flag is written in the same request as the ciphertext it
 *     describes (`payloadOf`, and one transaction in the controller), so no list is ever
 *     half-converted — the flag and the content cannot disagree
 *   - the flag is per list (§5), so "what is left to do" is a query, not something this has to
 *     remember across a crash
 *
 * So there is no progress state to persist and nothing to clean up after a failure. Run it
 * again and it picks up exactly where it stopped.
 */
export function createEncryptionPass({ lists, pushList }) {
  /** Lists still to convert, recomputed each time: the set shrinks as the pass proceeds. */
  const remaining = () => lists.value.filter((l) => !l.pendingDelete && !l.encrypted)

  /**
   * Fill in a list's items before rewriting it.
   *
   * Not optional. A record read from the index has `items: null` — unread, which is not the
   * same as empty — and pushing one of those would PUT an empty item set over real rows. The
   * encryption pass is the one place that touches every list, including ones the user has never
   * opened, so this is where that distinction matters most.
   */
  async function loadItems(record) {
    const { data } = await api.get(`shopping-list?list_id=${record.serverId}`)
    Object.assign(record, await recordFromApi(data), { id: record.id })
  }

  /**
   * Convert everything not yet converted.
   *
   * Returns what happened rather than throwing on a dead connection, because "eight of
   * twenty-five, stopped because the network went" is a normal outcome that the caller should
   * put on screen and offer to resume — not an error.
   *
   * @returns {Promise<{total: number, done: number, stopped: null|'offline'|'failed'|'conflict'}>}
   */
  async function encryptAll() {
    // Without a key this would push every list back as plaintext and flag none of them — a
    // no-op that looks like a completed pass, which is the worst of both.
    if (!isUnlocked()) throw new Error('Cannot encrypt: this device has no data key.')

    const total = remaining().length
    let done = 0

    for (const record of [...remaining()]) {
      try {
        if (record.items == null) await loadItems(record)
      } catch (err) {
        return { total, done, stopped: isNetworkError(err) ? 'offline' : 'failed' }
      }

      // `dirty` is what `pushList` writes; the content has not changed, only how it is stored.
      record.dirty = true
      const outcome = await pushList(record)

      if (outcome === 'offline' || outcome === 'failed') return { total, done, stopped: outcome }
      // Another device wrote first and its copy has been adopted, so this list is now something
      // this pass has not seen. Stopping is the honest move: the next run reads it fresh.
      if (outcome === 'conflict') return { total, done, stopped: 'conflict' }

      done++
    }

    return { total, done, stopped: null }
  }

  return { encryptAll, remaining }
}
