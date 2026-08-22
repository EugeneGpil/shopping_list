import { orderedLike } from '../order'
import { privates } from '../privates'
import { readState } from '../storage'

/**
 * Take what another tab wrote, keeping anything of ours it could not have known about.
 *
 * Every tab holds the whole collection and mirrors it wholesale, so without this the loser is
 * whichever writes last: a tab that has been sitting idle would flush its stale copy over
 * another tab's edit. Reading what they wrote is what stops ours being stale.
 *
 * The rule is "unsent local work wins": a record we hold `dirty` or tombstoned is a change no
 * one else has, so it stays and goes out on our next write. Everything else is theirs to
 * update — they wrote more recently than we last did.
 *
 * Two tabs holding unsent edits to the *same* list is the one case this cannot resolve; both
 * keep their own, and the server's version check settles it when they push.
 *
 * Called by the `storage` listener that `_hydrate` registers, and directly by the tests.
 */
export default function refreshFromStorage() {
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
  if (!this.orderDirty) this.lists = orderedLike(this.lists, incoming.lists)
  this.orderDirty = this.orderDirty || incoming.orderDirty

  // No write is forced here. Mutating anything above arms the usual debounce, and a
  // merge that changed nothing arms nothing — which is what stops two tabs writing back
  // and forth at each other forever.
}
