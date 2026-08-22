import { toRaw } from 'vue'

/**
 * The per-store values that must not be state: the debounce timers, the in-flight undo
 * snapshots, and the sync pass callers join.
 *
 * When each concern was a factory closing over its own `let`, these needed no home. As
 * plain actions on one option store they do, and `state` is the wrong one: a `setTimeout`
 * handle and a promise are not data, and the snapshots are whole-array copies that would be
 * deep-watched and mirrored to `localStorage` 300ms later for nothing.
 *
 * Keyed by the store instance rather than held at module level, because two instances can
 * be alive at once — that is exactly what the two-tab tests are — and a shared timer would
 * mean one tab cancelling the other's write.
 *
 * **Keyed by `toRaw(store)`, and that is load-bearing.** In development Pinia's devtools
 * hook calls every action with a *freshly built* `Proxy` over the store as `this`, so keying
 * on `this` directly hands out a new object on each call: a snapshot taken in `beginEdit`
 * would be invisible to `endEdit`, `flush()` would never see the pending save that
 * `_scheduleSave` set, and a second `sync()` would miss the pass in flight and start one of its
 * own — the doubled PUT `shoppingLists.spec.js` pins. `toRaw` reads through both that proxy
 * and Vue's reactive one to the single underlying store object, so every action agrees — and it
 * is the same in dev, in a production build, and under the tests, which is exactly what makes
 * it trustworthy.
 */
const scratch = new WeakMap()

export function privates(store) {
  const key = toRaw(store)
  let own = scratch.get(key)
  if (!own) {
    scratch.set(
      key,
      (own = {
        // index.js — the localStorage mirror, and whether the open list is untouched
        persistTimer: null,
        pristine: false,
        // persistence.js — the save debounce
        saveTimer: null,
        pendingSave: false,
        // sync.js — the pass in flight, so a second `sync()` can await it instead of its own
        syncPass: null,
        // history.js — snapshots held between focus and change, and across a drag
        editSnapshot: null,
        dragSnapshot: null,
        // settings.js — the title as it was before the current edit
        nameSnapshot: '',
      }),
    )
  }
  return own
}
