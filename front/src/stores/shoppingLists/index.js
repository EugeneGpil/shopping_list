import { watch } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { api, isNetworkError } from 'src/api'
import { useAuthStore } from 'src/stores/auth'
import collection from './collection'
import persistence, { SAVE_STATUS } from './persistence'
import history from './history'
import rows from './rows'
import settings from './settings'
import sync from './sync'
import { privates } from './privates'
import { forStorage, isTemp, recordFromApi, seedTempIds } from './record'
import { clearState, onExternalWrite, readState, writeState } from './storage'

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
 * rows, the per-list settings, and the sync engine. Each is an object of actions spread in
 * below, and each owns its own `_reset*()`. Getters and state stay here, so the shape of
 * the store is readable in one place; the timers and snapshots each module owns are in
 * `privates.js`, out of state.
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

    /** Changes waiting for a connection, for the "not synced yet" indicator. */
    pendingCount: (state) =>
      state.lists.filter((l) => l.dirty || l.pendingDelete).length + (state.orderDirty ? 1 : 0),

    canUndo: (state) => state._past.length > 0,
    canRedo: (state) => state._future.length > 0,
  },

  actions: {
    ...collection,
    ...persistence,
    ...history,
    ...rows,
    ...settings,
    ...sync,

    /**
     * Everything the store used to do while it was being constructed: read the device's copy
     * back, start mirroring to it, and listen for the other tabs.
     *
     * An option store has no constructor body, so this runs once per instance from the
     * `useShoppingListsStore` wrapper below — before anything can read a getter, which is
     * what keeps a cold launch rendering the cached lists on its first frame.
     */
    _hydrate() {
      const own = privates(this)

      // ---- local persistence ----
      //
      // Written through on every change rather than only when offline: `navigator.onLine` lies
      // (a connected wifi with no internet reports true), and a PWA is killed while online
      // just as often as offline. One code path, and crash safety for free.

      const persisted = readState(this._uid())
      if (persisted) {
        this.lists = persisted.lists
        this.orderDirty = persisted.orderDirty
        seedTempIds(this.lists)
      }

      watch(
        () => [this.lists, this.orderDirty],
        () => {
          clearTimeout(own.persistTimer)
          own.persistTimer = setTimeout(
            () => writeState(this._uid(), { lists: this.lists, orderDirty: this.orderDirty }),
            PERSIST_DEBOUNCE,
          )
        },
        // Synchronous so the timer is armed by the mutation itself rather than a microtask
        // later. `clear()` relies on that: it cancels the timer after emptying the store, and a
        // watcher that had not run yet would re-arm afterwards and write the empty state back.
        { deep: true, flush: 'sync' },
      )

      onExternalWrite(
        () => this._uid(),
        () => this.refreshFromStorage(),
      )
    },

    _uid() {
      return useAuthStore().user?.uid
    },

    /** The open list's rows, or null when nothing is open or nothing is loaded yet. Distinct
     *  from the `items` getter, whose `[]` is for rendering — here the null is the guard. */
    _rowList() {
      return this.current?.items ?? null
    },

    // Cleared by the first thing the user does to the open list; see `_revalidate()`.
    _touch() {
      privates(this).pristine = false
    },

    _markDirty() {
      if (this.current) this.current.dirty = true
    },

    _find(id) {
      return this.lists.find((l) => l.id === id)
    },

    _forget(id) {
      this.lists = this.lists.filter((l) => l.id !== id)
    },

    // Route params are strings while server ids are numbers, and lookups match on identity.
    // Temp ids are strings for their whole life, so only digits are converted.
    _normalizeId(id) {
      return /^\d+$/.test(String(id)) ? Number(id) : String(id)
    },

    // ---- the other tabs ----
    //
    // Every tab holds the whole collection and mirrors it wholesale, so without this the
    // loser is whichever writes last: a tab that has been sitting idle would flush its stale
    // copy over another tab's edit. Reading what they wrote is what stops ours being stale.

    /** Same shape for both sides of a comparison — item `_key`s are per-session and mean
     *  nothing across tabs, and `forStorage` is already the thing that drops them. */
    _sameRecord(a, b) {
      return JSON.stringify(forStorage([a])) === JSON.stringify(forStorage([b]))
    },

    /**
     * Take what another tab wrote, keeping anything of ours it could not have known about.
     *
     * The rule is "unsent local work wins": a record we hold `dirty` or tombstoned is a
     * change no one else has, so it stays and goes out on our next write. Everything else is
     * theirs to update — they wrote more recently than we last did.
     *
     * Two tabs holding unsent edits to the *same* list is the one case this cannot resolve;
     * both keep their own, and the server's version check settles it when they push.
     */
    refreshFromStorage() {
      const incoming = readState(this._uid())
      if (!incoming) return

      const ours = new Map(this.lists.map((l) => [l.id, l]))
      const theirs = new Map(incoming.lists.map((l) => [l.id, l]))

      for (const [id, their] of theirs) {
        const our = ours.get(id)
        if (!our) {
          this.lists.push(their)
          continue
        }
        if (our.dirty || our.pendingDelete) continue
        if (this._sameRecord(our, their)) continue
        // Adopting items swaps every row object, which would pull the caret out of a field
        // being typed in — the same reason `_revalidate()` only adopts into an untouched
        // list. Their copy stays on disk and arrives on the next open.
        if (id === this.openId && !privates(this).pristine) continue
        Object.assign(our, their)
      }

      // Gone there, and nothing of ours to lose: another tab saw the server accept a delete.
      for (const [id, our] of ours) {
        if (!theirs.has(id) && !our.dirty && !our.pendingDelete) this._forget(id)
      }

      // A pending reorder of ours outranks their order, since it is the unsent change; with
      // nothing pending, theirs is simply newer than ours.
      if (!this.orderDirty) {
        const rank = new Map(incoming.lists.map((l, i) => [l.id, i]))
        const last = rank.size
        this.lists.sort((a, b) => (rank.get(a.id) ?? last) - (rank.get(b.id) ?? last))
      }
      this.orderDirty = this.orderDirty || incoming.orderDirty

      // No write is forced here. Mutating anything above arms the usual debounce, and a
      // merge that changed nothing arms nothing — which is what stops two tabs writing back
      // and forth at each other forever.
    },

    /**
     * The index read, with the staleness flag around it. Wrapped here rather than folded into
     * `collection.js` so that module keeps knowing only about the collection, and so the
     * failure still reaches the page exactly as it did — the page decides between "show the
     * cached lists" and "we have nothing".
     */
    async fetchLists() {
      try {
        await this._fetchIndex()
        this.stale = false
      } catch (err) {
        if (isNetworkError(err)) this.stale = true
        throw err
      }
    },

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
    async _revalidate(id) {
      const record = this._find(id)
      if (!record?.serverId) return
      try {
        const { data } = await api.get(`shopping-list?list_id=${record.serverId}`)
        this.stale = false
        if (record.dirty) {
          if ((data.version ?? null) !== record.version) {
            await this._adopt(record, data)
            this._reportConflict(record)
          }
          return
        }
        if (privates(this).pristine && this.openId === record.id) await this._adopt(record, data)
      } catch (err) {
        // Offline, or gone: the cached copy is exactly what the user is already looking at.
        // Worth saying, though — it is a copy of unknown age from here on.
        if (isNetworkError(err)) this.stale = true
      }
    },

    /**
     * Ask about the open list again. For a reconnect: what is on screen was read from cache
     * and never confirmed, and nothing else would go back for it — `open()` is not the way,
     * as it would reset `pristine` and let a background refresh swap rows under a caret.
     */
    refreshOpen() {
      return this.openId == null ? undefined : this._revalidate(this.openId)
    },

    /**
     * Make `id` the open list. Returns the key of the blank row created for an empty list
     * (so the caller can focus it), or null.
     *
     * Throws only when the list is not cached and cannot be fetched — the caller decides
     * whether that means "bounce home" or "show it offline". A cached list never throws,
     * which is what makes a list openable with no connection at all.
     */
    async open(id) {
      const target = this._normalizeId(id)

      if (this.openId !== target) {
        // The outgoing list's debounced save still belongs to it, and `_save()` captures its
        // record synchronously, so fire it before the pointer moves.
        this.stopSaving()
        this._resetHistory()
        this._resetSettings()
      }
      this.openId = target
      this.saveStatus = ''
      privates(this).pristine = true

      const record = this.current
      if (record?.items != null) {
        this._revalidate(target)
        return this._ensureRow()
      }

      // Not cached. A temp list we no longer hold locally never existed anywhere else, so
      // there is nothing to fetch and no point pretending otherwise.
      const serverId = record?.serverId ?? (isTemp(target) ? null : target)
      if (!serverId) {
        this._forget(target)
        throw Object.assign(new Error('No such list'), { status: 404 })
      }

      try {
        // A session that started offline has no API token yet, and an unauthenticated GET is
        // answered 401 — which this page reads as final and leaves. See `retrySync`.
        await useAuthStore().retrySync()
        const { data } = await api.get(`shopping-list?list_id=${serverId}`)
        this.stale = false
        const fresh = await recordFromApi(data)
        if (record) Object.assign(record, fresh, { id: record.id })
        else this.lists.push(fresh)
      } catch (err) {
        // Gone for good: stop listing it. A transport failure says nothing about whether the
        // list exists, so in that case the record stays exactly as it was.
        if (err.status === 404) this._forget(target)
        throw err
      }
      return this._ensureRow()
    },

    /** Drop everything, here and on disk. Call on logout, or the next person to sign in on
     *  this browser sees these lists. */
    clear() {
      this._resetPersistence()
      this._resetHistory()
      this._resetSettings()
      this.lists = []
      this.orderDirty = false
      this.openId = null
      this.stale = false
      this.saveStatus = ''
      // After the mutations, not before: each one arms the write, and the whole point here is
      // that nothing gets written back.
      clearTimeout(privates(this).persistTimer)
      clearState(this._uid())
    },
  },
})

// One instance, hydrated the first time anything asks for it — see `_hydrate`. Two are alive
// at once in the two-tab tests, so the guard is per instance rather than a boolean.
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
