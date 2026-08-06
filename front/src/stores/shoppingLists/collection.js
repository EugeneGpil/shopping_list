import { api } from 'src/api'

/**
 * The collection itself: fetching the index, creating, deleting, reordering.
 *
 * Owns nothing of its own — every action here is a server call plus the matching edit
 * to `lists`, which is the store's state. Item-level work lives in `rows.js`.
 */
export function createCollection({ lists, upsert }) {
  const find = (id) => lists.value.find((l) => l.id === id)

  /**
   * Reload the index. Reconciles rather than replaces: a list we already hold keeps the
   * `items` it has cached (the index endpoint does not return them), while name, order
   * and count come from the server. Records the server no longer returns are dropped.
   */
  async function fetchLists() {
    const { data } = await api.get('shopping-lists')
    lists.value = data.map((entry) => {
      const known = find(entry.id)
      return known ? Object.assign(known, entry) : { ...entry, items: null }
    })
  }

  /**
   * Create a list and return its record. POST answers with the full list, so it is
   * cached complete — opening it straight afterwards needs no fetch at all.
   */
  async function createList(name) {
    const { data } = await api.post('shopping-lists', { name })
    return upsert({ ...data, items_count: 0, items: [] })
  }

  async function deleteList(id) {
    await api.del(`shopping-list?list_id=${id}`)
    lists.value = lists.value.filter((l) => l.id !== id)
  }

  /**
   * Apply a reorder from the index page's drag handle. The new order is kept even if
   * the request fails: position is cosmetic, and dropping a row back under the user's
   * finger is worse than an order that is one visit out of date.
   */
  async function reorderLists(ordered) {
    lists.value = ordered
    await api.put('shopping-lists/order', { ids: ordered.map((l) => l.id) }).catch(() => {})
  }

  return { fetchLists, createList, deleteList, reorderLists }
}
