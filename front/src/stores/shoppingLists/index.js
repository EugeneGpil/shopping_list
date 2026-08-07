import { computed, ref, watch } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { api } from 'src/api'
import { useAuthStore } from 'src/stores/auth'
import { createCollection } from './collection'
import { createPersistence, SAVE_STATUS } from './persistence'
import { createHistory } from './history'
import { createRows } from './rows'
import { createSettings } from './settings'
import { createSync } from './sync'
import { isTemp, recordFromApi, seedTempIds } from './record'
import { clearState, readState, writeState } from './storage'

// Long enough that a burst of keystrokes is one write, short enough that a phone killed
// straight after typing still has it.
const PERSIST_DEBOUNCE = 300

/**
 * Every shopping list the app knows about, and everything that changes one.
 *
 * `lists` is the single source of truth for both pages: the index renders each record's
 * `name` and `items_count`, the editor renders the `items` of whichever record `openId`
 * points at. There is one object per list and it is never copied, so a rename made in the
 * editor is already correct on the index.
 *
 * **The UI reads and writes this store, never the network.** Local state is authoritative
 * and mirrored into localStorage on every change, so the app works offline and across a
 * restart; `sync.js` gets it to the server whenever that is possible. A change therefore
 * never fails — it is only "not on the server yet", which is what `dirty` means. See
 * `record.js` for the bookkeeping each record carries and `docs/go_offline.md` for the
 * plan this implements.
 *
 * `items: null` means "not fetched yet", which is deliberately different from a list that
 * has no items. Once fetched, items stay cached: switching lists is instant, and — unlike
 * the single-open-list store this replaces — opening list B cannot flash list A's rows or
 * let A's pending save land on B, because each list's rows live under its own record.
 *
 * Split by concern, one module each: the collection, the local write path, undo/redo, the
 * rows, the per-list settings, and the sync engine. Each owns its internals (the save
 * timer, the history stacks, the name snapshot) and exposes its own `reset()`.
 */
export const useShoppingListsStore = defineStore('shoppingLists', () => {
  const lists = ref([])
  // The order differs from the server's and has not been sent yet. One flag for the whole
  // collection, because the endpoint takes the whole order in one call.
  const orderDirty = ref(false)
  const openId = ref(null)
  const saveStatus = ref('')
  // The two states worth interrupting for: a real failure, and an edit that lost to a
  // newer copy. "Saved on this device" is not one of them — that is normal offline life.
  const saveFailed = computed(
    () => saveStatus.value === SAVE_STATUS.failed || saveStatus.value === SAVE_STATUS.conflict,
  )

  /** The open list's record, or null when nothing is open. */
  const current = computed(() => lists.value.find((l) => l.id === openId.value) ?? null)

  /** Nothing may be saved before the items have been fetched, or a first debounce would
   *  PUT an empty list over real data. */
  const isLoaded = () => current.value?.items != null

  // Read-only facades over the open record, for rendering. Every write is an action.
  const items = computed(() => current.value?.items ?? [])
  const listName = computed(() => current.value?.name ?? '')
  const showQuantity = computed(() => current.value?.show_quantity ?? true)
  const showCheckbox = computed(() => current.value?.show_checkbox ?? true)

  /** Tombstoned lists stay in `lists` until the server agrees, but are not shown. */
  const visibleLists = computed(() => lists.value.filter((l) => !l.pendingDelete))
  /** Changes waiting for a connection, for the "not synced yet" indicator. */
  const pendingCount = computed(
    () => lists.value.filter((l) => l.dirty || l.pendingDelete).length + (orderDirty.value ? 1 : 0),
  )

  // Cleared by the first thing the user does to the open list; see `revalidate()`.
  let pristine = false
  const touch = () => {
    pristine = false
  }
  const markDirty = () => {
    if (current.value) current.value.dirty = true
  }

  // ---- local persistence ----
  //
  // Written through on every change rather than only when offline: `navigator.onLine` lies
  // (a connected wifi with no internet reports true), and a PWA is killed while online
  // just as often as offline. One code path, and crash safety for free.

  const uid = () => useAuthStore().user?.uid

  const persisted = readState(uid())
  if (persisted) {
    lists.value = persisted.lists
    orderDirty.value = persisted.orderDirty
    seedTempIds(lists.value)
  }

  let persistTimer = null
  watch(
    [lists, orderDirty],
    () => {
      clearTimeout(persistTimer)
      persistTimer = setTimeout(
        () => writeState(uid(), { lists: lists.value, orderDirty: orderDirty.value }),
        PERSIST_DEBOUNCE,
      )
    },
    // Synchronous so the timer is armed by the mutation itself rather than a microtask
    // later. `clear()` relies on that: it cancels the timer after emptying the store, and a
    // watcher that had not run yet would re-arm afterwards and write the empty state back.
    { deep: true, flush: 'sync' },
  )

  // ---- wiring ----

  const sync = createSync({ lists, orderDirty, forget })

  const persistence = createPersistence({
    current,
    openId,
    saveStatus,
    isLoaded,
    touch,
    markDirty,
    pushList: sync.pushList,
  })

  const history = createHistory({
    current,
    scheduleSave: persistence.scheduleSave,
    touch,
  })

  const rows = createRows({
    current,
    record: history.record,
    scheduleSave: persistence.scheduleSave,
    markDirty,
  })

  const settings = createSettings({ current, save: persistence.save })

  const collection = createCollection({
    lists,
    orderDirty,
    pushDelete: sync.pushDelete,
    pushOrder: sync.pushOrder,
  })

  const find = (id) => lists.value.find((l) => l.id === id)

  function forget(id) {
    lists.value = lists.value.filter((l) => l.id !== id)
  }

  // Route params are strings while server ids are numbers, and lookups match on identity.
  // Temp ids are strings for their whole life, so only digits are converted.
  const normalizeId = (id) => (/^\d+$/.test(String(id)) ? Number(id) : String(id))

  /**
   * Refresh a list that is already on screen from cache. Deliberately not awaited: the
   * cached copy renders immediately and this only catches up with the server.
   *
   * With local changes pending, the version decides: if the server is still on the one our
   * edit was based on, the edit is fine and will be pushed — leave it. If it has moved on,
   * the newer copy wins and the user is told, which is the same rule the server's 409
   * applies at push time.
   *
   * With nothing pending there is nothing to lose, but replacing the items still swaps
   * every row object, which would pull the caret out of a field being typed in — so only a
   * list the user has not touched since opening is replaced.
   */
  async function revalidate(id) {
    const record = find(id)
    if (!record?.serverId) return
    try {
      const { data } = await api.get(`shopping-list?list_id=${record.serverId}`)
      if (record.dirty) {
        if ((data.version ?? null) !== record.version) {
          sync.adopt(record, data)
          sync.reportConflict(record)
        }
        return
      }
      if (pristine && openId.value === record.id) sync.adopt(record, data)
    } catch {
      // Offline, or gone: the cached copy is exactly what the user is already looking at.
    }
  }

  /**
   * Make `id` the open list. Returns the key of the blank row created for an empty list
   * (so the caller can focus it), or null.
   *
   * Throws only when the list is not cached and cannot be fetched — the caller decides
   * whether that means "bounce home" or "show it offline". A cached list never throws,
   * which is what makes a list openable with no connection at all.
   */
  async function open(id) {
    const target = normalizeId(id)

    if (openId.value !== target) {
      // The outgoing list's debounced save still belongs to it, and `save()` captures its
      // record synchronously, so fire it before the pointer moves.
      persistence.stopSaving()
      history.reset()
      settings.reset()
    }
    openId.value = target
    saveStatus.value = ''
    pristine = true

    const record = current.value
    if (record?.items != null) {
      revalidate(target)
      return rows.ensureRow()
    }

    // Not cached. A temp list we no longer hold locally never existed anywhere else, so
    // there is nothing to fetch and no point pretending otherwise.
    const serverId = record?.serverId ?? (isTemp(target) ? null : target)
    if (!serverId) {
      forget(target)
      throw Object.assign(new Error('No such list'), { status: 404 })
    }

    try {
      // A session that started offline has no API token yet, and an unauthenticated GET is
      // answered 401 — which this page reads as final and leaves. See `retrySync`.
      await useAuthStore().retrySync()
      const { data } = await api.get(`shopping-list?list_id=${serverId}`)
      const fresh = recordFromApi(data)
      if (record) Object.assign(record, fresh, { id: record.id })
      else lists.value.push(fresh)
    } catch (err) {
      // Gone for good: stop listing it. A transport failure says nothing about whether the
      // list exists, so in that case the record stays exactly as it was.
      if (err.status === 404) forget(target)
      throw err
    }
    return rows.ensureRow()
  }

  /** Drop everything, here and on disk. Call on logout, or the next person to sign in on
   *  this browser sees these lists. */
  function clear() {
    persistence.reset()
    history.reset()
    settings.reset()
    lists.value = []
    orderDirty.value = false
    openId.value = null
    saveStatus.value = ''
    // After the mutations, not before: each one arms the write, and the whole point here is
    // that nothing gets written back.
    clearTimeout(persistTimer)
    clearState(uid())
  }

  return {
    // state
    lists,
    visibleLists,
    items,
    listName,
    showQuantity,
    showCheckbox,
    saveStatus,
    saveFailed,
    pendingCount,
    syncing: sync.syncing,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    // the open list
    open,
    clear,
    flush: persistence.flush,
    stopSaving: persistence.stopSaving,
    // the collection
    fetchLists: collection.fetchLists,
    createList: collection.createList,
    deleteList: collection.deleteList,
    reorderLists: collection.reorderLists,
    // sync
    sync: sync.sync,
    // history
    undo: history.undo,
    redo: history.redo,
    beginEdit: history.beginEdit,
    endEdit: history.endEdit,
    beginDrag: history.beginDrag,
    endDrag: history.endDrag,
    // list settings
    setListName: settings.setListName,
    beginNameEdit: settings.beginNameEdit,
    saveName: settings.saveName,
    toggleQuantity: settings.toggleQuantity,
    toggleCheckbox: settings.toggleCheckbox,
    // rows
    setName: rows.setName,
    setQuantity: rows.setQuantity,
    toggleChecked: rows.toggleChecked,
    addRow: rows.addRow,
    addRowAfter: rows.addRowAfter,
    splitRow: rows.splitRow,
    mergeRowUp: rows.mergeRowUp,
    removeRow: rows.removeRow,
    reorder: rows.reorder,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useShoppingListsStore, import.meta.hot))
}
