/**
 * Ask about the open list again.
 *
 * For a reconnect: what is on screen was read from cache and never confirmed, and nothing else
 * would go back for it — `open()` is not the way, as it would reset `pristine` and let a
 * background refresh swap rows under a caret.
 */
export default function refreshOpen() {
  return this.openId == null ? undefined : this._revalidate(this.openId)
}
