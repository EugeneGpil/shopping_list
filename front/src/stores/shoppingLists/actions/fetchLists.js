import { isNetworkError } from 'src/api'

/**
 * The index read, with the queue flushed first and the staleness flag around it.
 *
 * Wrapped here rather than folded into `collection.js` so that module keeps knowing only about
 * the collection, and so the failure still reaches the page exactly as it did — the page decides
 * between "show the cached lists" and "we have nothing".
 *
 * **The flush is what stops a deleted list flickering back.** The index read and a queued
 * `DELETE` used to go out together on reconnect, and an index answered a moment before the
 * delete committed still names the list — while by the time that answer is read, the successful
 * delete has already dropped the record. So `_fetchIndex` finds an entry it holds nothing for,
 * which is indistinguishable from a list created on another device: the list comes back as a
 * fresh record with `pendingDelete: false` and renders. Self-healing — tapping it 404s and the
 * next index drops it — but a list the user deleted reappearing is not something to leave in.
 *
 * Here rather than in the page so every caller gets it: the unlock's catch-up and the trash's
 * restore reload read the index for the same reasons and would each need their own copy.
 *
 * What the await guarantees is ordering and nothing more: a pass that was running when this was
 * called has finished before the read is issued. Not an empty queue — a joined pass may have
 * started before this device's change was flagged, and any pass stops early on 'offline' or
 * 'locked'. Enough for the reconnect, which is a queued `DELETE` racing the index read. A delete
 * tapped while the read is already in flight goes out through `deleteList` rather than a pass and
 * can still land inside it; nothing here changes that.
 *
 * Costs nothing on the paths that matter. A first-ever load has an empty queue, so the pass makes
 * no requests at all; the index page renders the cached lists on its first frame and treats this
 * as a background refresh, so even a real flush is invisible. And `sync()` is joinable, so the
 * trash page — which awaits the same pass before its own read — waits out one flush rather than
 * causing a second.
 */
export default async function fetchLists() {
  try {
    await this.sync()
    await this._fetchIndex()
    this.stale = false
  } catch (err) {
    if (isNetworkError(err)) this.stale = true
    throw err
  }
}
