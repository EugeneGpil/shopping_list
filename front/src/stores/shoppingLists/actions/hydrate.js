import { watch } from 'vue'
import { privates } from '../privates'
import { seedTempIds } from '../record'
import { onExternalWrite, readState, writeState } from '../storage'

// Long enough that a burst of keystrokes is one write, short enough that a phone killed
// straight after typing still has it.
const PERSIST_DEBOUNCE = 300

/**
 * Everything the store used to do while it was being constructed: read the device's copy
 * back, start mirroring to it, and listen for the other tabs.
 *
 * An option store has no constructor body, so this runs once per instance from the
 * `useShoppingListsStore` wrapper in `index.js` — before anything can read a getter, which is
 * what keeps a cold launch rendering the cached lists on its first frame.
 *
 * The mirroring is written through on every change rather than only when offline:
 * `navigator.onLine` lies (a connected wifi with no internet reports true), and a PWA is
 * killed while online just as often as offline. One code path, and crash safety for free.
 */
export default function _hydrate() {
  const own = privates(this)

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
}
