import { api, isNetworkError } from 'src/api'
import { useAuthStore } from 'src/stores/auth'
import { localRecord, recordFromApi, recordFromIndexEntry } from './record'

/**
 * The collection itself: fetching the index, creating, deleting, reordering.
 *
 * Every action here lands locally first and only then tries the server, so all four work
 * offline. Item-level work lives in `rows.js`; getting any of it to the server is
 * `sync.js`'s job.
 */
export function createCollection({ lists, orderDirty, pushDelete, pushOrder }) {
  const find = (id) => lists.value.find((l) => l.id === id)

  /**
   * Take what the index endpoint can tell us about a list we already hold. It carries no
   * items, which is what makes this narrower than it looks.
   */
  function applyIndexEntry(known, entry) {
    known.items_count = entry.items_count
    // Local content the server has not accepted yet outranks anything it tells us; the
    // conflict is settled at push time, where the version check lives.
    if (known.dirty) return
    known.name = entry.name
    // Only a full read may refresh the version our items are based on. Adopting it here
    // would make a stale item set look current, and the next push would then be accepted
    // and overwrite newer rows.
    if (known.items == null) known.version = entry.version ?? null
  }

  /**
   * Reload the index. Reconciles rather than replaces, so cached items, unpushed edits and
   * tombstones all survive; anything the server no longer returns is dropped, which is how
   * a list deleted on another device disappears here.
   */
  async function fetchLists() {
    // A session that started offline has no API token yet, and an unauthenticated GET comes
    // back 401 rather than failing at the transport — which would look like a definitive
    // "no lists for you" instead of "we could not ask". See `retrySync`.
    await useAuthStore().retrySync()
    const { data } = await api.get('shopping-lists')

    const matched = new Set()
    const fromServer = data.map((entry) => {
      const known = lists.value.find((l) => l.serverId === entry.id)
      if (!known) return recordFromIndexEntry(entry)
      matched.add(known.id)
      applyIndexEntry(known, entry)
      return known
    })
    // Lists the server cannot know about yet: created here and not pushed, or tombstoned
    // and not yet accepted. Both must outlive a refresh or the queue would be lost.
    const localOnly = lists.value.filter(
      (l) => !matched.has(l.id) && (!l.serverId || l.pendingDelete),
    )
    lists.value = [...fromServer, ...localOnly]
  }

  /**
   * Create a list and return its record — usable immediately either way. Online it comes
   * back with a server id; offline it gets a local one and `sync` creates it later.
   */
  async function createList(name) {
    try {
      const { data } = await api.post('shopping-lists', { name })
      const record = recordFromApi(data)
      lists.value.push(record)
      return record
    } catch (err) {
      if (!isNetworkError(err)) throw err
      const record = localRecord(name)
      lists.value.push(record)
      return record
    }
  }

  /**
   * Delete a list. Tombstoned first so it leaves the screen at once, then sent. Offline the
   * flag *is* the queue — and because `fetchLists` keeps tombstones, the next refresh
   * cannot resurrect it from the server index.
   */
  async function deleteList(id) {
    const record = find(id)
    if (!record) return 'saved'
    record.pendingDelete = true
    return pushDelete(record)
  }

  /**
   * Apply a reorder from the index page's drag handle. `ordered` holds the visible rows, so
   * tombstones are appended back — they are invisible anyway, and their place in the order
   * stops mattering the moment they are deleted.
   */
  async function reorderLists(ordered) {
    lists.value = [...ordered, ...lists.value.filter((l) => l.pendingDelete)]
    orderDirty.value = true
    await pushOrder()
  }

  return { fetchLists, createList, deleteList, reorderLists }
}
