import { defineStore, acceptHMRUpdate } from 'pinia'
import collection from './collection'
import persistence, { SAVE_STATUS } from './persistence'
import history from './history'
import rows from './rows'
import settings from './settings'
import sync from './sync'
import clear from './actions/clear'
import fetchLists from './actions/fetchLists'
import _find from './actions/find'
import _forget from './actions/forget'
import _hydrate from './actions/hydrate'
import _markDirty from './actions/markDirty'
import _normalizeId from './actions/normalizeId'
import open from './actions/open'
import refreshFromStorage from './actions/refreshFromStorage'
import refreshOpen from './actions/refreshOpen'
import _revalidate from './actions/revalidate'
import _rowList from './actions/rowList'
import _sameRecord from './actions/sameRecord'
import _touch from './actions/touch'
import _uid from './actions/uid'

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
 * **This file is the shape of the store and nothing else**: the state, the getters, and the
 * assembly below. The behaviour is next door, in two kinds of neighbour:
 *
 *   - one module per concern, each an object of actions — the collection, the local write
 *     path, undo/redo, the rows, the per-list settings, the sync engine. Each owns its own
 *     `_reset*()`, and the timers and snapshots they own are in `privates.js`, out of state.
 *   - `actions/`, one file per action for the ones that belong to no single concern: opening
 *     a list, the tab merge, hydration, and the handful of one-line helpers the rest lean on.
 *
 * Everything prefixed `_` is internal. An option store has no way to keep a member private,
 * so the prefix is the only line between "the UI calls this" and "this is plumbing".
 */
const definition = defineStore('shoppingLists', {
  state: () => ({
    lists: [],
    // The order differs from the server's and has not been sent yet. One flag for the whole
    // collection, because the endpoint takes the whole order in one call.
    orderDirty: false,
    openId: null,
    saveStatus: '',
    // The last read of the server's copy did not get through, so everything on screen is
    // whatever was last saved to this device — right at the time it was written, and of
    // unknown age since. Deliberately one flag for the whole store rather than per list: the
    // thing that went wrong is the connection, and it went wrong for all of them.
    stale: false,
    // sync.js — a pass is in flight, and a second one is dropped rather than queued.
    syncing: false,
    // history.js — the undo and redo stacks for the open list.
    _past: [],
    _future: [],
  }),

  getters: {
    // The two states worth interrupting for: a real failure, and an edit that lost to a
    // newer copy. "Saved on this device" is not one of them — that is normal offline life.
    saveFailed: (state) =>
      state.saveStatus === SAVE_STATUS.failed || state.saveStatus === SAVE_STATUS.conflict,

    /** The open list's record, or null when nothing is open. */
    current: (state) => state.lists.find((l) => l.id === state.openId) ?? null,

    /** Nothing may be saved before the items have been fetched, or a first debounce would
     *  PUT an empty list over real data. */
    isLoaded() {
      return this.current?.items != null
    },

    // Read-only facades over the open record, for rendering. Every write is an action.
    items() {
      return this.current?.items ?? []
    },
    listName() {
      return this.current?.name ?? ''
    },
    /**
     * How many rows the index says the open list has, or 0 when it has not said, for sizing
     * the loading placeholder.
     */
    currentItemsCount() {
      return this.current?.items_count ?? 0
    },
    /** Whether the open list is one of the encrypted ones — what lights the lock in its header. */
    currentEncrypted() {
      return !!this.current?.encrypted
    },
    showQuantity() {
      return this.current?.show_quantity ?? true
    },
    showCheckbox() {
      return this.current?.show_checkbox ?? true
    },

    /**
     * The total of the rows, when the list is one a total makes sense for: no quantity
     * column, and every row a whole number. That is a list being used as a tally — money
     * counted out, weights, a running balance — and adding it up is the only thing left to
     * do with it. `null` means "not that kind of list", which is the normal case.
     *
     * Blank rows are skipped rather than disqualifying, because there is nearly always one:
     * a new list starts with an empty row and Enter at the end of a name leaves another.
     * A signed row counts as written — "-40" subtracts.
     *
     * `_` is a digit separator and is ignored, as it is in PHP and JS source: "50_000" is
     * fifty thousand. It is what makes a column of five- and six-figure numbers readable at
     * a glance, which is exactly the list that most wants a total.
     *
     * Anything else that is not a whole number stops it, decimals included: guessing what
     * "1.5 kg" or "12 eggs" should add up to is how a total starts lying.
     */
    numericTotal() {
      if (this.showQuantity) return null
      let total = 0
      let seen = 0
      for (const row of this.items) {
        const text = (row.name ?? '').trim()
        // Blank is judged on the row as written, so a row of nothing but separators is a
        // row with something in it that is not a number, not an empty one to skip over.
        if (!text) continue
        // Separators are stripped rather than matched around, so one is allowed anywhere in
        // the number — including a trailing one, halfway through typing "50_000", where
        // refusing would make the total flicker away mid-keystroke.
        const digits = text.replace(/_/g, '')
        if (!/^[+-]?\d+$/.test(digits)) return null
        total += Number(digits)
        seen++
      }
      return seen ? total : null
    },

    /** Tombstoned lists stay in `lists` until the server agrees, but are not shown. */
    visibleLists: (state) => state.lists.filter((l) => !l.pendingDelete),

    /**
     * How many of the lists on screen are locked. Read by the encryption store, which needs
     * it for the one rule it cannot answer alone: removing the last passkey while any list is
     * still encrypted would leave that list unopenable for good.
     */
    encryptedCount() {
      return this.visibleLists.filter((l) => l.encrypted).length
    },

    /** Changes waiting for a connection, for the "not synced yet" indicator. */
    pendingCount: (state) =>
      state.lists.filter((l) => l.dirty || l.pendingDelete).length + (state.orderDirty ? 1 : 0),

    canUndo: (state) => state._past.length > 0,
    canRedo: (state) => state._future.length > 0,
  },

  actions: {
    // One object of actions per concern.
    ...collection,
    ...persistence,
    ...history,
    ...rows,
    ...settings,
    ...sync,

    // The rest, a file each under `actions/`. The open list.
    open,
    clear,
    refreshOpen,
    _revalidate,
    fetchLists,
    // What another tab wrote.
    refreshFromStorage,
    _sameRecord,
    // Startup, and the helpers the modules above lean on.
    _hydrate,
    _uid,
    _rowList,
    _find,
    _forget,
    _normalizeId,
    _touch,
    _markDirty,
  },
})

// One instance, hydrated the first time anything asks for it — see `actions/hydrate.js`. Two are
// alive at once in the two-tab tests, so the guard is per instance rather than a boolean.
const hydrated = new WeakSet()

export function useShoppingListsStore(...args) {
  const store = definition(...args)
  if (!hydrated.has(store)) {
    hydrated.add(store)
    store._hydrate()
  }
  return store
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot))
}
