import { api } from 'src/api'
import { useAuthStore } from 'src/stores/auth'
import { privates } from '../privates'
import { EncryptionLockedError, isUnlocked } from '../encryption'
import { isTemp, recordFromApi } from '../record'

/**
 * Make `id` the open list. Returns the key of the blank row created for an empty list
 * (so the caller can focus it), or null.
 *
 * Throws for three reasons, and the caller tells them apart: the list is not cached and cannot be
 * fetched — "bounce home" or "show it offline"; it is encrypted and this session has no key, which
 * is a fingerprint prompt; or the key is here and the bytes would not open, which is a dead end
 * (`DecryptionFailedError`). A cached plaintext list never throws, which is what makes a list
 * openable with no connection at all.
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
    // The cache holds this list in the clear (§7 decided that), so serving it would put a
    // locked list on screen readable, with no prompt anywhere — and the refresh below cannot
    // say so, because it is deliberately not awaited and its own `EncryptionLockedError` — now a
    // `DecryptionFailedError` too — has nowhere to go. So the check happens here, on the call the
    // page awaits, and the seam's own error type is what it raises: `openList` already turns that
    // into the unlock panel.
    //
    // The list's flag decides, as everywhere else (§4) — not whether the cached rows look like
    // ciphertext, which the plaintext cache means they never do. On this branch the flag is the
    // cached one, and nothing corrects it here — the throw is above `_revalidate`, so a list
    // another device has since unlocked keeps prompting until the next index read. Accepted:
    // checking above both branches would refuse such a list without ever asking the server, and
    // the fetch path gets the refusal from the seam using the server's own flag.
    if (record.encrypted && !isUnlocked()) throw new EncryptionLockedError()

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
