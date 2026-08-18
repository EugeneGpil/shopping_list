import { isNetworkError } from 'src/api'

/**
 * The index read, with the staleness flag around it.
 *
 * Wrapped here rather than folded into `collection.js` so that module keeps knowing only about
 * the collection, and so the failure still reaches the page exactly as it did — the page decides
 * between "show the cached lists" and "we have nothing".
 */
export default async function fetchLists() {
  try {
    await this._fetchIndex()
    this.stale = false
  } catch (err) {
    if (isNetworkError(err)) this.stale = true
    throw err
  }
}
