import { defineStore, acceptHMRUpdate } from 'pinia'
import { toRaw, watch } from 'vue'
import { Notify } from 'quasar'
import { api, isNetworkError } from 'src/api'
import { useAuthStore } from 'src/stores/auth'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { trashedRecordFromApi } from 'src/stores/shoppingLists/record'

/**
 * The trash: lists that were deleted and are not gone yet.
 *
 * Offline-first, exactly like the lists store and for the same reason — a phone that has been
 * put in a pocket is the normal state of this app, not an error condition. So the trash is
 * mirrored to this device and the two actions it offers are queued rather than refused:
 * `restore` and `purge` mark their intent locally, the entry leaves the screen at once, and
 * `sync()` gets it to the server whenever that becomes possible. The flag on the entry *is*
 * the queue, as `pendingDelete` is for a list.
 *
 * Queuing destruction is the part worth justifying. "Delete for good" queued offline is not a
 * promise the app breaks: the list stays on the server, still trashed, still counting down its
 * retention window, until the request lands or the window runs out and the nightly prune does
 * the same job. The only thing the user is told is that the decision is saved, which is true.
 *
 * The honest gap is a queued **restore**: the entry leaves the trash immediately, but the list
 * cannot appear on the index until the server has actually restored it — the index is built
 * from server ids and item sets this store does not hold, and inventing a record for it would
 * risk the next push writing an empty item set over the real rows. So between queueing and
 * syncing the list is in neither place, and the "waiting to sync" line on the trash page is
 * what stops that being silent.
 *
 * One file rather than the directory the lists store needed: this is one screen's worth of
 * state — entries with two flags, plus the cached payloads `view()` reads — and splitting it
 * would spread eight short actions over six files. The parts that are copied from over there
 * say where they came from.
 */

// Bump when the cached shape changes in a way old data cannot satisfy: a stale key is never
// read again, which is cheaper than migrating it. Its own key, never shared with the lists —
// they are written at different moments and one would clobber the other's copy.
const KEY = 'trash:v1'

// Scoped per user, as `shoppingLists/storage.js` is: localStorage outlives a logout and the
// next person to sign in on this browser must not find the names of someone else's deleted
// lists sitting there.
const keyFor = (uid) => `${KEY}:${uid || 'anon'}`

// Long enough that a burst of queued actions is one write, short enough that a phone killed
// straight after the last tap still has it. The same figure the lists store uses.
const PERSIST_DEBOUNCE = 300

/**
 * The debounce timer, out of state and keyed by `toRaw(store)` — see `shoppingLists/privates.js`
 * for why both halves of that matter: a `setTimeout` handle is not data, and in development
 * Pinia hands each action a freshly built proxy as `this`, so keying on `this` directly would
 * give every call its own timer and `clear()` would cancel one that was never armed.
 */
const timers = new WeakMap()

const timerFor = (store) => {
  const key = toRaw(store)
  if (!timers.has(key)) timers.set(key, { persistTimer: null })

  return timers.get(key)
}

/**
 * A decision made on this entry and not sent yet. The flag *is* the queue, so this reads as both
 * "hide it from the trash" and "the server has already been asked, or will be by `sync()` — do
 * not ask again".
 *
 * Exported for the inspect page, which asks the same question about the list it is showing: with
 * the predicate in one place, a third flag added to `entryFrom` cannot leave that page's banner
 * saying the opposite of what the store thinks.
 */
export const isQueued = (entry) => entry.pendingRestore || entry.pendingPurge

/**
 * The outcome to report when a request got no answer worth acting on — a push, or the probe
 * that would have resolved its 404. Keeps the entry flagged either way; the two strings differ
 * only in what the pages say and in whether `sync()` stops the pass, and a server error is no
 * reason to think the next attempt fails the same way.
 */
const unresolved = (err) => (isNetworkError(err) ? 'offline' : 'failed')

/**
 * Every field an entry has, with the value it takes when the caller knows nothing about it.
 *
 * Stated once for the same reason `makeRecord` is: the server's shape and a cache written by an
 * older build both come through here, so an entry can be wrong about a value but can no longer
 * be missing one — a `pendingPurge` that arrives as `undefined` reads as "not queued" today and
 * as a crash the day something counts the flags.
 */
const entryFrom = (fields) => ({
  id: null,
  name: '',
  encrypted: false,
  items_count: 0,
  deleted_at: null,
  purge_at: null,
  // Restore or delete-for-good, decided here and not sent yet. Either one hides the entry.
  pendingRestore: false,
  pendingPurge: false,
  ...fields,
})

function readState(uid) {
  try {
    const raw = localStorage.getItem(keyFor(uid))
    if (!raw) return null
    const state = JSON.parse(raw)

    return {
      entries: (state.entries ?? []).map(entryFrom),
      payloads: state.payloads ?? {},
    }
  } catch {
    // Corrupt, or storage denied outright (Safari private mode throws on read). Starting empty
    // is safe: the server still knows what is in the trash.
    return null
  }
}

function writeState(uid, { entries, payloads }) {
  try {
    localStorage.setItem(keyFor(uid), JSON.stringify({ entries, payloads }))
  } catch {
    // Quota exceeded, or storage denied. The app keeps working; it just forgets on reload.
  }
}

const definition = defineStore('trash', {
  state: () => ({
    /**
     * One entry per trashed list — `GET trash`'s shape plus the two queue flags. No items:
     * the trash page renders names and counts, and the full read is `view()`.
     */
    entries: [],
    /**
     * The raw `GET trash/list` payload of every list that has been inspected, by id, so
     * opening one again works with no connection.
     *
     * Safe to trust, which is unusual, and it comes from the one property a trashed list has:
     * it is immutable. There is no write endpoint for it, so a cached copy cannot drift from
     * the list it is a copy of — it either still exists, or it has left the trash and `_forget`
     * drops the payload with the entry.
     *
     * The bound is a list that left the trash and came back — restored, edited and deleted
     * again on another device — which keeps its id and so lands under the same key. Nothing
     * repairs that entry in place: `_pruneCachedPayloads` only drops ids the server has stopped
     * returning, and this one is still trashed. What contains it is `_payload`, which asks the
     * server first every time and reads the cache only when the transport failed — so the one
     * way to see the old copy is to be offline, which is also the only time it is better than
     * nothing.
     *
     * Cached **raw**, before the seam: an encrypted list's rows stay ciphertext on disk, so
     * inspecting a locked list once does not leave its contents readable in localStorage.
     */
    payloads: {},
    /** There is a copy of the trash to render — from the server, or from this device. */
    loaded: false,
    /**
     * The last read of the server's copy did not get through, so what is on screen is whatever
     * this device last saved. One flag for the whole store, as in the lists: the thing that
     * went wrong is the connection.
     */
    stale: false,
    /** A sync pass is in flight; a second one is dropped rather than queued. */
    syncing: false,
  }),

  getters: {
    /**
     * What belongs on screen. A queued entry is gone from the trash as far as the person who
     * tapped is concerned — the same reason `visibleLists` hides a tombstoned list.
     */
    visibleEntries: (state) => state.entries.filter((e) => !isQueued(e)),

    count() {
      return this.visibleEntries.length
    },

    /** Decisions waiting for a connection, for the "not synced yet" line. */
    pendingCount: (state) => state.entries.filter((e) => isQueued(e)).length,

    /**
     * How many locked lists are in the trash, for the one rule that has to count them: removing
     * the last passkey while any list is still encrypted. Read by the encryption store alongside
     * the lists' own `encryptedCount` — see `lockedListCount`.
     *
     * Not `visibleEntries`: a list queued for restore is on its way back and needs its key more
     * than ever, while one queued for purge is on its way out and must not hold a passkey
     * hostage. So the filter is "still in the trash", which is neither of the other two counts.
     */
    encryptedCount: (state) => state.entries.filter((e) => !e.pendingPurge && e.encrypted).length,
  },

  actions: {
    /**
     * Read the device's copy back and start mirroring to it.
     *
     * Runs once per instance from the `useTrashStore` wrapper below, because an option store
     * has no constructor body — and before anything can read a getter, which is what lets the
     * trash page render its first frame from the cache instead of a spinner.
     *
     * No `storage` listener, unlike the lists: the only writer is whichever tab the user is
     * acting in, and the worst a second, idle tab can do is flush its own copy over a queued
     * action. That tab still holds the flag in memory and pushes it on its next sync, so the
     * action is lost only if that tab is closed first — a queue of one tap, on a screen visited
     * once in a blue moon, against the machinery `refreshFromStorage` needs to merge two copies.
     */
    _hydrate() {
      const own = timerFor(this)
      const persisted = readState(this._uid())
      if (persisted) {
        this.entries = persisted.entries
        this.payloads = persisted.payloads
        // Not "the server answered" but "there is something true to show": a cold launch in a
        // tunnel renders the cached trash, and `stale` is what says how old it might be.
        this.loaded = true
      }

      watch(
        () => [this.entries, this.payloads],
        () => {
          clearTimeout(own.persistTimer)
          own.persistTimer = setTimeout(
            () => writeState(this._uid(), { entries: this.entries, payloads: this.payloads }),
            PERSIST_DEBOUNCE,
          )
        },
        // Synchronous so the timer is armed by the mutation itself: `clear()` cancels it after
        // emptying the store, and a watcher that had not run yet would re-arm afterwards and
        // write the empty state back.
        { deep: true, flush: 'sync' },
      )
    },

    /** Who the cached copy belongs to. Read now, not captured — a tab can change user. */
    _uid() {
      return useAuthStore().user?.uid
    },

    _find(id) {
      return this.entries.find((e) => e.id === id)
    },

    /**
     * Reload the trash, keeping what the server cannot know about.
     *
     * Reconciles rather than replaces: an entry with a queued action stays, because that flag is
     * the only record of a decision the server has not been told about — and `sync()` is what
     * resolves it, including the case where the list has meanwhile left the trash elsewhere.
     * Everything else is the server's to state, so an entry it no longer returns is dropped:
     * restored or purged on another device, or pruned at the end of its window.
     *
     * Rethrows after flagging staleness, exactly as `fetchLists` does, so the page can tell
     * "here is the cached trash" from "we have nothing to show you".
     */
    async fetch() {
      try {
        // A session that started offline has no API token yet, and an unauthenticated GET comes
        // back 401 rather than failing at the transport — which would look like a definitive
        // "your trash is empty" instead of "we could not ask".
        await useAuthStore().retrySync()
        // A list deleted offline is trashed only on this device, so until its tombstone lands
        // the server's trash is missing it — and the reconcile below keeps nothing for a list
        // this store has never heard of, so a delete that races this read leaves the list in
        // neither place until the page is revisited. Flushed first for the same reason the
        // token is refreshed first: the answer is only accurate once both are true. A pass the
        // reconnect has already started counts, which is why that `sync()` joins rather than
        // returning on a flag.
        //
        // The cost, accepted rather than hidden: `sync()` is the only entry point the lists
        // store offers, and it flushes everything pending — creates, edits and the order as
        // well as tombstones — so opening the trash page can push unrelated list edits, and
        // their conflict warnings can surface on this screen. And since the pass is joined
        // rather than skipped, this read also waits out a flush it did not start.
        await useShoppingListsStore().sync()
        const { data } = await api.get('trash')

        const queued = this.entries.filter((e) => isQueued(e))
        const queuedIds = new Set(queued.map((e) => e.id))
        this.entries = [
          ...(data ?? []).filter((e) => !queuedIds.has(e.id)).map(entryFrom),
          // Appended rather than merged into the server's order: they are invisible anyway.
          ...queued,
        ]
        this._pruneCachedPayloads()
        this.loaded = true
        this.stale = false
      } catch (err) {
        if (isNetworkError(err)) this.stale = true
        throw err
      }
    },

    /**
     * One trashed list in full, for looking at before deciding.
     *
     * Through `trashedRecordFromApi`, which crosses the encryption seam
     * (`docs/go_encrypted.md` §4): a trashed list is still ciphertext on the server, and this is
     * what opens it — so a locked one throws `EncryptionLockedError` here exactly as it would in
     * the editor and the page offers the same fingerprint prompt. Deliberately outside the
     * network fallback below: a missing key is not something a second copy of the same bytes
     * can fix.
     *
     * The record it returns is never pushed anywhere. It is not in the lists store, nothing
     * syncs it, and the page that renders it has no way to write to it — which is what makes
     * "inspect but not edit" structural rather than a hidden button.
     */
    async view(id) {
      return trashedRecordFromApi(await this._payload(id))
    },

    /** The server's copy of a trashed list, or the one this device already has. */
    async _payload(id) {
      try {
        const { data } = await api.get(`trash/list?list_id=${id}`)
        this.payloads[id] = data
        this._noteTrashed(data)

        return data
      } catch (err) {
        // Cached copies are only ever consulted when the server could not be reached: a 404 is
        // an answer — the list has left the trash — and serving the cache over it would show a
        // list that no longer exists, with two buttons that would both fail.
        const cached = this.payloads[id]
        if (cached && isNetworkError(err)) return cached
        throw err
      }
    },

    /**
     * Record that this list is in the trash, learnt from a full read rather than the index.
     *
     * Needed because the inspect page is a URL: opening `/trash/list/5` on a device that has
     * never listed the trash reads the list fine and yet has no entry to hang a queued action
     * on — so `restore` there would find nothing, report success and put nothing back.
     *
     * Only ever adds, and never overwrites. Not because the two sources disagree — both send
     * the same stored `name` — but because an entry that is already here may be carrying a
     * queued `pendingRestore` or `pendingPurge`, and replacing it wholesale would drop the only
     * record of a decision the server has not been told about.
     */
    _noteTrashed(data) {
      if (this._find(data.id)) return
      this.entries.push(
        entryFrom({
          id: data.id,
          name: data.name ?? '',
          encrypted: !!data.encrypted,
          items_count: (data.items ?? []).length,
          deleted_at: data.deleted_at ?? null,
          purge_at: data.purge_at ?? null,
        }),
      )
    },

    /**
     * Put a list back. Queued the moment it is asked for, then pushed.
     *
     * This and `purge` report what happened rather than throwing, because every caller carries
     * on either way — the two pages and `sync()` alike, as `_pushList` and `_pushDelete` do:
     *
     *   'saved'     the server has done it, or had already: a restore whose list is back, a
     *               purge whose list is gone. What was asked for is true, however it came to be.
     *   'offline'   not done, and the entry keeps its flag so the next sync takes it again.
     *   'failed'    the same, after an answer that was not a refusal of the request itself.
     *   'queued'    this device had already decided this and not sent it yet — a second tap.
     *               Nothing new was asked of the server, so there is nothing new to say.
     *   'gone'      restore only: destroyed elsewhere, so the list is not coming back.
     *   'restored'  purge only: put back elsewhere, so nothing was deleted.
     *
     * The last two are the two halves of a 404 (see `_fateOf`), and both are announced from
     * this store rather than left to the caller: `sync()` is a caller too, so either can
     * resolve hours later with nobody on the trash page to be told.
     */
    async restore(id) {
      const entry = this._find(id)
      if (!entry) return 'saved'
      // A second tap on a row whose first tap has not come back yet. Firing again would send a
      // request the server answers 404 — the list left the trash a moment ago, by this very
      // device — and put `_fateOf` to work on an anomaly this device caused. Only the two
      // public actions are guarded: `sync()` pushes the flagged entries directly, which is the
      // flag's own turn to go out rather than a repeat of it.
      if (isQueued(entry)) return 'queued'
      entry.pendingRestore = true

      return this._pushRestore(entry)
    },

    /** Remove a list for good, now rather than when the retention window runs out. */
    async purge(id) {
      const entry = this._find(id)
      if (!entry) return 'saved'
      if (isQueued(entry)) return 'queued'
      entry.pendingPurge = true

      return this._pushPurge(entry)
    },

    /**
     * Which of the two opposite things a 404 meant: 'live' | 'gone' | 'offline' | 'failed'.
     *
     * Both pushes below are scoped `onlyTrashed` on the server, so a 404 says the list has left
     * the trash and not which way it left — destroyed elsewhere, or restored elsewhere, and no
     * flag on this device can tell those apart. The live endpoint can, and one extra request on
     * a path that is already an anomaly is cheap next to announcing the wrong one of the two.
     * Only meaningful after one of those 404s: it is what rules out the third reading of a 404
     * from the live endpoint — a list that is still in the trash.
     *
     * The probe failing is not an answer, so it comes back as the same 'offline' / 'failed' the
     * pushes use: nothing is claimed, the entry keeps its flag, and the next sync asks again.
     */
    async _fateOf(id) {
      try {
        await api.get(`shopping-list?list_id=${id}`)

        return 'live'
      } catch (err) {
        return err.status === 404 ? 'gone' : unresolved(err)
      }
    },

    async _pushRestore(entry) {
      try {
        await api.post(`trash/restore?list_id=${entry.id}`)
      } catch (err) {
        if (err.status !== 404) return unresolved(err)

        const fate = await this._fateOf(entry.id)
        if (fate === 'gone') {
          // Destroyed while the restore sat in the queue — purged on another device, or pruned
          // at the end of its window. Worth interrupting for: somebody asked for this list back
          // and it is not coming, and silently dropping the entry would read as success.
          Notify.create({
            type: 'warning',
            multiLine: true,
            timeout: 8000,
            message: `"${entry.name}" could not be restored — it was deleted for good elsewhere before this device could put it back.`,
          })
          this._forget(entry.id)

          return 'gone'
        }
        if (fate !== 'live') return fate
        // Put back elsewhere first, which is the thing that was asked for. So it ends exactly
        // as a restore this device performed does, and the caller gets to say so calmly.
      }
      this._forget(entry.id)
      // After the entry is gone, on both ways of reaching here: the list is live, and a failure
      // to reload the index is only an index a moment out of date — which the index page's own
      // staleness handling already covers. Reported as a restore failure it would put the entry
      // back on the trash page for a list that is no longer in the trash.
      await this._refreshLists()

      return 'saved'
    },

    /**
     * Reload the lists index so a restored list reappears there.
     *
     * The reload is the point: the lists store drops a record when the server accepts its
     * delete, so after a restore it holds nothing at all about this list and only the index can
     * tell it what came back — including where in the order it came back.
     */
    async _refreshLists() {
      try {
        await useShoppingListsStore().fetchLists()
      } catch {
        // Already flagged `stale` over there, which is the index page's business, not ours.
      }
    },

    async _pushPurge(entry) {
      try {
        await api.del(`trash?list_id=${entry.id}`)
      } catch (err) {
        if (err.status !== 404) return unresolved(err)

        const fate = await this._fateOf(entry.id)
        if (fate === 'live') {
          // Put back elsewhere before this device could destroy it, so the deletion the user
          // confirmed did not happen — and saying nothing is what a completed purge says. The
          // list is not gone, it is on the index, and only this can tell them so.
          Notify.create({
            type: 'warning',
            multiLine: true,
            timeout: 8000,
            message: `"${entry.name}" was not deleted — it had been put back on another device, so it is in your lists again.`,
          })
          this._forget(entry.id)
          // The index has not been read since that restore, so without this the list they have
          // just been told about is nowhere on screen.
          await this._refreshLists()

          return 'restored'
        }
        if (fate !== 'gone') return fate
        // Already destroyed, which is exactly what was asked for — and unlike a queued restore
        // there is nothing to tell anyone: the outcome is the one they wanted.
      }
      this._forget(entry.id)

      return 'saved'
    },

    /**
     * Flush the queue.
     *
     * Serialised, and a second call while one is running is dropped. Deliberately *unlike* the
     * lists' `sync`, which hands the caller the pass in flight: nothing awaits this one for a
     * guarantee — `MainLayout` fires it and moves on — and the entries a dropped call would have
     * covered are still flagged, so the next trigger takes them. Give it a joiner the day
     * something has to wait for the pass, not before.
     *
     * Bails on the first offline result — the rest would fail the same way, and the next trigger
     * starts again.
     */
    async sync() {
      if (this.syncing) return
      this.syncing = true
      try {
        for (const entry of this.entries.filter((e) => isQueued(e))) {
          const outcome = entry.pendingRestore
            ? await this._pushRestore(entry)
            : await this._pushPurge(entry)
          if (outcome === 'offline') return
        }
      } finally {
        this.syncing = false
      }
    },

    /** Gone from the trash, whichever way it left — so the inspected copy goes with it. */
    _forget(id) {
      this.entries = this.entries.filter((e) => e.id !== id)
      delete this.payloads[id]
    },

    _pruneCachedPayloads() {
      const here = new Set(this.entries.map((e) => String(e.id)))
      for (const id of Object.keys(this.payloads)) {
        if (!here.has(id)) delete this.payloads[id]
      }
    },

    /**
     * Drop everything, here and on disk. Call on logout, or the next person to sign in on this
     * browser sees the names of these deleted lists — and, for any that were inspected, their
     * contents.
     *
     * Must run *before* the auth store forgets who is leaving: the cache key is scoped by uid,
     * so called afterwards this clears the key for `anon` and leaves the real one on the device.
     * See `clearLocalState` on the index page.
     */
    clear() {
      this.entries = []
      this.payloads = {}
      this.loaded = false
      this.stale = false
      // After the mutations, not before: each one arms the write, and the whole point here is
      // that nothing gets written back.
      clearTimeout(timerFor(this).persistTimer)
      try {
        localStorage.removeItem(keyFor(this._uid()))
      } catch {
        // If we cannot remove it we could not have written it either.
      }
    },
  },
})

// One instance, hydrated the first time anything asks for it, as the lists store is. A WeakSet
// rather than a boolean because two instances can be alive at once under the tests.
const hydrated = new WeakSet()

export function useTrashStore(...args) {
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
