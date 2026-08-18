import { api, isNetworkError } from 'src/api'
import { privates } from '../privates'

/**
 * Refresh a list that is already on screen from cache. Deliberately not awaited by its callers:
 * the cached copy renders immediately and this only catches up with the server.
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
export default async function _revalidate(id) {
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
}
