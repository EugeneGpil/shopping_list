import { api } from 'src/api'
import { useAuthStore } from 'src/stores/auth'
import { privates } from '../privates'
import { isTemp, recordFromApi } from '../record'

/**
 * Make `id` the open list. Returns the key of the blank row created for an empty list
 * (so the caller can focus it), or null.
 *
 * Throws only when the list is not cached and cannot be fetched — the caller decides
 * whether that means "bounce home" or "show it offline". A cached list never throws,
 * which is what makes a list openable with no connection at all.
 */
export default async function open(id) {
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
}
