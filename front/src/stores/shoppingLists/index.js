import { computed, ref } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { api } from 'src/api'
import { createCollection } from './collection'
import { createPersistence, SAVE_STATUS } from './persistence'
import { createHistory } from './history'
import { createRows } from './rows'
import { createSettings } from './settings'

/**
 * Every shopping list the app knows about, and everything that changes one.
 *
 * `lists` is the single source of truth for both pages: the index page renders each
 * record's `name` and `items_count`, the editor page renders the `items` of whichever
 * record `openId` points at. There is one object per list and it is never copied, so a
 * rename made in the editor is already correct on the index.
 *
 * `items: null` means "not fetched yet", which is deliberately different from a list
 * that has no items. Once fetched, items stay cached for the session: switching lists
 * is then instant, and — unlike the single-open-list store this replaces — opening
 * list B can no longer flash list A's rows or let A's pending save land on B, because
 * each list's rows live under its own record instead of in one shared slot.
 *
 * Components never write to any of this. Every mutation is an action here, which is
 * what keeps the undo snapshot and the debounced save impossible to bypass.
 *
 * Split by concern, one module each: the lists collection, the debounced save, undo/
 * redo, the rows, and the per-list settings. Each owns its internals (the save timer,
 * the history stacks, the key counter, the name snapshot) and exposes its own
 * `reset()`, which is why the roll-call below is short. Dependencies run one way and
 * are visible in the wiring: everything sits on top of `current`.
 */
export const useShoppingListsStore = defineStore('shoppingLists', () => {
  const lists = ref([])
  const openId = ref(null)
  const saveStatus = ref('')
  // So the UI can style a failure without matching on the message text.
  const saveFailed = computed(() => saveStatus.value === SAVE_STATUS.failed)

  /** The open list's record, or null when nothing is open. */
  const current = computed(() => lists.value.find((l) => l.id === openId.value) ?? null)

  /** Nothing may be saved before the items have been fetched, or a first debounce
   *  would PUT an empty list over real data. */
  const isLoaded = () => current.value?.items != null

  // Read-only facades over the open record, for rendering. Every write is an action.
  const items = computed(() => current.value?.items ?? [])
  const listName = computed(() => current.value?.name ?? '')
  const showQuantity = computed(() => current.value?.show_quantity ?? true)
  const showCheckbox = computed(() => current.value?.show_checkbox ?? true)

  // Cleared by the first thing the user does to the open list; see `revalidate()`.
  let pristine = false
  const touch = () => {
    pristine = false
  }

  const persistence = createPersistence({ current, openId, saveStatus, isLoaded, touch })

  const history = createHistory({
    current,
    scheduleSave: persistence.scheduleSave,
    touch,
  })

  const rows = createRows({
    current,
    record: history.record,
    scheduleSave: persistence.scheduleSave,
  })

  const settings = createSettings({
    current,
    openId,
    saveStatus,
    report: persistence.report,
  })

  const collection = createCollection({ lists, upsert })

  /** Merge a freshly fetched record into `lists`, keeping the existing object identity
   *  so anything already rendering it follows along. */
  function upsert(record) {
    const known = lists.value.find((l) => l.id === record.id)
    if (known) Object.assign(known, record)
    else lists.value.push(record)
    return record
  }

  function forget(id) {
    lists.value = lists.value.filter((l) => l.id !== id)
  }

  /** GET one list, with its items turned into rows. */
  async function fetchOne(id) {
    const { data } = await api.get(`shopping-list?list_id=${id}`)
    return {
      id: data.id,
      name: data.name,
      show_quantity: data.show_quantity ?? true,
      show_checkbox: data.show_checkbox ?? true,
      // Kept in step with the items we just received, so a list reached by URL before
      // the index has ever been fetched still has a count to show.
      items_count: data.items.length,
      items: data.items.map((i) =>
        rows.createRow({ name: i.name, quantity: i.quantity ?? '', checked: !!i.checked }),
      ),
    }
  }

  /**
   * Refresh a list that is already on screen from cache. Deliberately not awaited: the
   * cached copy renders immediately and this only catches up with the server.
   *
   * The response is applied only if the user has not touched the list since it opened.
   * Replacing the items swaps every row object, which would discard an edit that has
   * not been saved yet and yank the caret out of the field being typed in — and the
   * cached copy is the one the user has been editing, so it wins. Focusing a field is
   * itself a touch (`beginEdit`), so this covers typing that has not landed yet too.
   *
   * Failures are silent by design: offline, the cached copy is exactly what the user is
   * already looking at, and there is nothing to report.
   */
  async function revalidate(id) {
    try {
      const record = await fetchOne(id)
      if (pristine && openId.value === id) upsert(record)
    } catch {
      // ignored on purpose — see above
    }
  }

  /**
   * Make `id` the open list. Returns the key of the blank row created for an empty
   * list (so the caller can focus it), or null.
   *
   * Throws only when the list is not cached and cannot be fetched — the caller decides
   * whether that means "bounce home" or "show it offline"; a cached list never throws.
   */
  async function open(id) {
    // Route params are strings and API ids are numbers, and `current` matches on
    // identity — so normalise here, once, rather than at every comparison.
    const target = Number(id)

    if (openId.value !== target) {
      // The outgoing list's debounced save still belongs to it, and `save()` captures
      // its id and payload synchronously, so fire it before the pointer moves.
      persistence.stopSaving()
      history.reset()
      settings.reset()
    }
    openId.value = target
    saveStatus.value = ''
    pristine = true

    if (isLoaded()) {
      revalidate(target)
      return rows.ensureRow()
    }

    try {
      upsert(await fetchOne(target))
    } catch (err) {
      // Gone for good: stop listing it. A transport failure says nothing about whether
      // the list exists, so in that case the record stays exactly as it was.
      if (err.status === 404) forget(target)
      throw err
    }
    return rows.ensureRow()
  }

  /** Drop everything. Call on logout, or the next user briefly sees these lists. */
  function clear() {
    persistence.reset()
    history.reset()
    settings.reset()
    lists.value = []
    openId.value = null
    saveStatus.value = ''
  }

  return {
    // state
    lists,
    items,
    listName,
    showQuantity,
    showCheckbox,
    saveStatus,
    saveFailed,
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
    removeRow: rows.removeRow,
    reorder: rows.reorder,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useShoppingListsStore, import.meta.hot))
}
