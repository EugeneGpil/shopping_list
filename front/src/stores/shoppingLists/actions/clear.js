import { privates } from '../privates'
import { clearState } from '../storage'

/**
 * Drop everything, here and on disk. Call on logout, or the next person to sign in on this
 * browser sees these lists.
 *
 * Must run *before* the auth store forgets who is leaving: both the cache key and `clearState`
 * are scoped by uid, so called afterwards this clears the key for `anon` and leaves the real one
 * sitting on the device. See `clearLocalState` on the index page.
 */
export default function clear() {
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
}
