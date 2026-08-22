import { api, isNetworkError } from 'src/api'
import { useAuthStore } from 'src/stores/auth'
import { createRow, localRecord, recordFromApi, recordFromIndexEntry } from './record'

/**
 * The collection itself: fetching the index, creating, deleting, reordering.
 *
 * Every action here lands locally first and only then tries the server, so all four work
 * offline. Item-level work lives in `rows.js`; getting any of it to the server is
 * `sync.js`'s job.
 */
export default {
  /**
   * Take what the index endpoint can tell us about a list we already hold. It carries no
   * items, which is what makes this narrower than it looks.
   */
  _applyIndexEntry(known, entry) {
    known.items_count = entry.items_count ?? 0
    // Local content the server has not accepted yet outranks anything it tells us; the
    // conflict is settled at push time, where the version check lives.
    if (known.dirty) return
    known.name = entry.name
    known.encrypted = !!entry.encrypted
    // Only a full read may refresh the version our items are based on. Adopting it here
    // would make a stale item set look current, and the next push would then be accepted
    // and overwrite newer rows.
    if (known.items == null) known.version = entry.version ?? null
  },

  /**
   * Reload the index. Reconciles rather than replaces, so cached items, unpushed edits and
   * tombstones all survive; anything the server no longer returns is dropped, which is how
   * a list deleted on another device disappears here.
   *
   * `fetchLists` in `index.js` is what the app calls — it wraps this with the staleness flag.
   */
  async _fetchIndex() {
    // A session that started offline has no API token yet, and an unauthenticated GET comes
    // back 401 rather than failing at the transport — which would look like a definitive
    // "no lists for you" instead of "we could not ask". See `retrySync`.
    await useAuthStore().retrySync()
    const { data } = await api.get('shopping-lists')

    const matched = new Set()
    // No key needed anywhere in here — the index carries titles and counts, both plaintext
    // whatever a list's flag says. That is what lets the app open, sync and render with no
    // unlock at all until an encrypted list is actually opened (§1).
    const fromServer = data.map((entry) => {
      const known = this.lists.find((l) => l.serverId === entry.id)
      if (!known) return recordFromIndexEntry(entry)
      matched.add(known.id)
      this._applyIndexEntry(known, entry)
      return known
    })
    // Lists the server cannot know about yet: created here and not pushed, or tombstoned
    // and not yet accepted. Both must outlive a refresh or the queue would be lost.
    const localOnly = this.lists.filter((l) => !matched.has(l.id) && (!l.serverId || l.pendingDelete))
    this.lists = [...fromServer, ...localOnly]
  },

  /**
   * Create a list and return its record — usable immediately either way. Online it comes
   * back with a server id; offline it gets a local one and `sync` creates it later.
   */
  async createList(name) {
    try {
      // Born plaintext, always. Encryption is something a list is given afterwards, by the
      // person who decides this one holds something private (§1) — a new list cannot be that
      // yet, and defaulting to encrypted would put a fingerprint prompt in front of the most
      // ordinary thing the app does.
      const { data } = await api.post('shopping-lists', { name })
      const record = await recordFromApi(data)
      this.lists.push(record)
      return record
    } catch (err) {
      if (!isNetworkError(err)) throw err
      const record = localRecord(name)
      this.lists.push(record)
      return record
    }
  },

  /**
   * Add several ready-made lists at once, as an import does.
   *
   * They are born exactly like a list created offline — a temp id and `dirty` — so nothing
   * here talks to the server: `sync` sees new records and creates each one, then PUTs its
   * items, using the same path every other write uses. That is what makes an import of
   * twenty lists survive a dead connection halfway through, and why importing is not
   * something that can half-fail.
   *
   * @param {{ title: string, items: string[] }[]} incoming
   */
  importLists(incoming) {
    const records = incoming.map(({ title, items }) => ({
      ...localRecord(title),
      items: items.map((name) => createRow({ name })),
      items_count: items.length,
      // Keep has no quantity, so every imported row would carry an empty column.
      show_quantity: false,
    }))
    this.lists.push(...records)
    // The new lists sit at the end here, and the server has to be told that too — without
    // it they would land wherever the server's own numbering put them.
    this.orderDirty = true
    return records
  },

  /**
   * Delete a list. Tombstoned first so it leaves the screen at once, then sent. Offline the
   * flag *is* the queue — and because `_fetchIndex` keeps tombstones, the next refresh
   * cannot resurrect it from the server index.
   */
  async deleteList(id) {
    const record = this._find(id)
    if (!record) return 'saved'
    record.pendingDelete = true
    return this._pushDelete(record)
  },

  /**
   * Apply a reorder from the index page's drag handle. `ordered` holds the visible rows, so
   * tombstones are appended back — they are invisible anyway, and their place in the order
   * stops mattering the moment they are deleted.
   */
  async reorderLists(ordered) {
    this.lists = [...ordered, ...this.lists.filter((l) => l.pendingDelete)]
    this.orderDirty = true
    await this._pushOrder()
  },
}
