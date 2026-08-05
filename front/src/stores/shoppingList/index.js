import { computed, ref } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { api } from 'src/api'
import { createPersistence, SAVE_STATUS } from './persistence'
import { createHistory } from './history'
import { createRows } from './rows'
import { createSettings } from './settings'

/**
 * The list currently open on ShoppingListPage: its rows, its column settings,
 * undo/redo, and the debounced save.
 *
 * Split by concern into four modules. Each one owns its internals — the save
 * timer, the history stacks, the key counter, the name snapshot — and exposes its
 * own `reset()`, which is why `reset()` here is just a roll-call rather than a
 * list of seven variables. Dependencies run one way and are visible in the wiring
 * below: settings and rows depend on history and persistence; persistence depends
 * on nothing.
 *
 * A setup store rather than the options style used by the other stores, because
 * those internals have no business being reactive state.
 *
 * This store outlives the page that uses it, so `reset()` MUST run before the
 * first render of a newly opened list — otherwise navigating list A -> list B
 * briefly shows A's rows, and A's pending debounce could save into B.
 */
export const useShoppingListStore = defineStore('shoppingList', () => {
  const listId = ref(null)
  const listName = ref('')
  const showQuantity = ref(true)
  const showCheckbox = ref(true)
  const items = ref([])
  const saveStatus = ref('')
  // So the UI can style a failure without matching on the message text.
  const saveFailed = computed(() => saveStatus.value === SAVE_STATUS.failed)

  const persistence = createPersistence({ listId, items, saveStatus })

  const history = createHistory({
    items,
    scheduleSave: persistence.scheduleSave,
  })

  const rows = createRows({
    items,
    record: history.record,
    scheduleSave: persistence.scheduleSave,
  })

  const settings = createSettings({
    listId,
    listName,
    showQuantity,
    showCheckbox,
    saveStatus,
    report: persistence.report,
  })

  function reset() {
    persistence.reset()
    history.reset()
    settings.reset()
    // rows deliberately keeps its key counter across lists — see rows.js
    listId.value = null
    listName.value = ''
    showQuantity.value = true
    showCheckbox.value = true
    items.value = []
    saveStatus.value = ''
  }

  /**
   * Fetch a list and make it the current one. Returns the key of the blank row
   * created for an empty list (so the caller can focus it), or null. Throws if
   * the list can't be loaded — the caller decides where to send the user.
   */
  async function load(id) {
    reset()
    listId.value = id
    const { data } = await api.get(`shopping-list?list_id=${id}`)
    listName.value = data.name
    showQuantity.value = data.show_quantity ?? true
    showCheckbox.value = data.show_checkbox ?? true
    items.value = data.items.map((i) =>
      rows.createRow({ name: i.name, quantity: i.quantity ?? '', checked: !!i.checked }),
    )
    persistence.markLoaded()
    return rows.ensureRow()
  }

  return {
    // state
    listId,
    listName,
    showQuantity,
    showCheckbox,
    items,
    saveStatus,
    saveFailed,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    // lifecycle
    load,
    reset,
    flush: persistence.flush,
    stopSaving: persistence.stopSaving,
    // history
    undo: history.undo,
    redo: history.redo,
    beginEdit: history.beginEdit,
    endEdit: history.endEdit,
    beginDrag: history.beginDrag,
    endDrag: history.endDrag,
    // list settings
    beginNameEdit: settings.beginNameEdit,
    saveName: settings.saveName,
    toggleQuantity: settings.toggleQuantity,
    toggleCheckbox: settings.toggleCheckbox,
    // rows
    toggleChecked: rows.toggleChecked,
    addRow: rows.addRow,
    addRowAfter: rows.addRowAfter,
    removeRow: rows.removeRow,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useShoppingListStore, import.meta.hot))
}
