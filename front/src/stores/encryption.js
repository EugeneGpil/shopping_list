import { computed, ref } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { api, isNetworkError } from 'src/api'
import { deriveKek, generateDek, randomSalt, unwrapDek, wrapDek } from 'src/utils/crypto'
import { isPasskeySupported, passkeyPrf, registerPasskey } from 'src/utils/passkey'
import { useAuthStore } from 'src/stores/auth'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { clearDek, getDek, isUnlocked, setDek } from 'src/stores/shoppingLists/encryption'

/**
 * The key, and the passkeys that open it — §6's flows.
 *
 * This store owns everything *about* the key: which passkeys can open it, whether this session
 * holds it yet, and the two operations that involve a fingerprint (create, unlock). Which
 * lists are encrypted is not its business — that is a per-list setting and lives with the
 * lists (§1). It deliberately does not own the key itself either: that is a module variable in
 * `stores/shoppingLists/encryption.js`, out of any state that gets deep-watched and mirrored
 * to `localStorage`.
 *
 * The wrapped copies are cached on the device so that unlocking works with no connection:
 * `navigator.credentials.get()` is local, so the only thing an offline unlock would otherwise
 * be missing is the blob to unwrap. The cache is safe to keep in the clear — it is the same
 * opaque row the server holds, and useless without the passkey.
 */

const CACHE_KEY = 'shopping_lists:encryption:v1'
const cacheKeyFor = (uid) => `${CACHE_KEY}:${uid || 'anon'}`

function readCache(uid) {
  try {
    return JSON.parse(localStorage.getItem(cacheKeyFor(uid)) ?? 'null') ?? []
  } catch {
    return []
  }
}

function writeCache(uid, keys) {
  try {
    localStorage.setItem(cacheKeyFor(uid), JSON.stringify(keys))
  } catch {
    // Quota or private mode. Costs an offline unlock, nothing else.
  }
}

export const useEncryptionStore = defineStore('encryption', () => {
  const auth = useAuthStore()
  const uid = () => auth.user?.uid

  /** One row per registered passkey: `{ credential_id, hkdf_salt, wrapped_key, created_at }`. */
  const keys = ref(readCache(uid()))
  /** Whether the question "is encryption on?" has been answered yet, from cache or server. */
  const ready = ref(false)
  /** Mirrors the module-level key, so the UI can react to it. */
  const unlocked = ref(isUnlocked())
  const busy = ref(false)

  /** There is a key for this account. Says nothing about any particular list. */
  const enabled = computed(() => keys.value.length > 0)
  /**
   * There is a key and this session has not opened it — so an encrypted list cannot be read
   * yet. Nothing acts on this by itself: it is what the editor checks when it is asked for a
   * list the server holds encrypted, and nowhere else.
   */
  const locked = computed(() => enabled.value && !unlocked.value)

  function remember(rows) {
    keys.value = rows
    writeCache(uid(), rows)
  }

  /**
   * Find out whether encryption is on. Called on boot, before anything tries to read a list.
   *
   * Falls back to the cache when the server cannot be reached, because "we could not ask" must
   * not read as "encryption is off" — that would send the app straight into showing ciphertext
   * as list names.
   */
  async function load() {
    try {
      const { data } = await api.get('encryption')
      remember(data ?? [])
    } catch (err) {
      // 401 lands here too: nothing is known about this user yet, so the cache is all there is.
      if (!isNetworkError(err) && err.status !== 401) throw err
    } finally {
      ready.value = true
    }
  }

  /**
   * The one refusal worth making before a passkey prompt rather than after it.
   *
   * Only the missing API is fatal. A device with no built-in authenticator is merely unusual —
   * a USB security key satisfies WebAuthn too — so `hasPlatformAuthenticator` is left to the
   * setup screen to warn about rather than checked here.
   */
  function assertPasskeySupport() {
    if (!isPasskeySupported()) {
      throw new Error('This browser cannot use passkeys, so it cannot encrypt your lists.')
    }
  }

  /**
   * Wrap the data key for one credential and store it. Shared by "create the key" and "add
   * another passkey", because they differ only in where the DEK came from.
   *
   * **No label is sent.** The endpoint takes one and the column is there for a name the user
   * types, but the app will not invent one: the only thing it could derive it from is the user
   * agent, which says "Chrome on Android" for the installed Play Store build too — a wrong
   * answer, stored on a server that cannot be shown to be wrong, in a row whose whole purpose
   * is to be opaque. The date it was added is a truthful way to tell two apart.
   */
  async function registerKey(dek) {
    const { credentialId, prf } = await registerPasskey({
      userId: uid() ?? 'local',
      userName: auth.user?.email ?? 'Shopping list',
      displayName: auth.user?.displayName ?? auth.user?.email ?? 'Shopping list',
    })

    const hkdf_salt = randomSalt()
    const kek = await deriveKek(prf, hkdf_salt)
    const wrapped_key = await wrapDek(dek, kek)

    await api.put('encryption', { credential_id: credentialId, hkdf_salt, wrapped_key })
    await load()

    return credentialId
  }

  /**
   * Create the key: one new passkey, one new data key, one wrapped copy on the server.
   *
   * **It converts nothing.** Encryption is per list (§1), so setting the key up leaves every
   * existing list exactly as it was and simply makes "encrypt this list" possible. That is
   * what keeps this cheap enough to do before it is needed, rather than as a decision about
   * the whole account.
   *
   * Needs a connection: a key this device holds but the server has no wrapped copy of would
   * encrypt lists that nothing could ever open again.
   */
  async function createKey() {
    if (enabled.value) throw new Error('This account already has an encryption key.')
    busy.value = true
    try {
      assertPasskeySupport()

      const dek = await generateDek()
      await registerKey(dek)

      // Only after the server has the wrapped copy — see above.
      setDek(dek)
      unlocked.value = true
    } finally {
      busy.value = false
    }
  }

  /**
   * Open the encrypted lists on this device: one fingerprint prompt, one unwrap, then catch up.
   *
   * Asked for when one is opened, not on boot — an account with a key and no encrypted list
   * open has nothing to unlock *for*, and prompting anyway is the tax this design exists to
   * avoid (§1).
   *
   * Works offline — the authenticator is local and the wrapped copy is cached. The wrong
   * credential does not need detecting: its KEK fails at the GCM tag inside `unwrapDek`.
   *
   * **The catching up happens before `unlocked` flips, and the order is load-bearing.** The
   * flag is what the editor watches to know it can open the list it was refused, and
   * `fetchLists` rebuilds the collection wholesale — so a page that reacted to the flag first
   * would race that rebuild and have its freshly fetched items replaced by an index entry that
   * carries none. Flipping last means everything downstream sees a collection that has settled.
   */
  async function unlock() {
    if (!enabled.value) return
    busy.value = true
    try {
      const { credentialId, prf } = await passkeyPrf(keys.value.map((k) => k.credential_id))

      // A resident-credential prompt can return a passkey this account has no wrapped copy
      // for — another account's, on a shared device.
      const row = keys.value.find((k) => k.credential_id === credentialId)
      if (!row) throw new Error('That passkey is not registered for these lists.')

      const kek = await deriveKek(prf, row.hkdf_salt)
      setDek(await unwrapDek(row.wrapped_key, kek))

      const lists = useShoppingListsStore()
      try {
        // Edits to an encrypted list made before the key arrived were held back rather than
        // written in the clear (`payloadOf`), and this is the trigger that knows they can go.
        await lists.sync()
        // Cheap, and it settles the collection before the editor reacts — see above.
        await lists.fetchLists()
      } catch (err) {
        // Offline is not a failed unlock — the key is here and the cache is what the user is
        // already looking at. Anything else is worth surfacing, but not by staying locked.
        if (!isNetworkError(err)) throw err
      } finally {
        unlocked.value = true
      }
    } finally {
      busy.value = false
    }
  }

  /**
   * Give a second passkey access to the same data key — §1's entire recovery story, and the
   * only way to read these lists on a device the first passkey does not sync to.
   *
   * Requires this session to be unlocked, because the DEK being wrapped has to be the one
   * every list is already encrypted under. The server cannot check that (§5), so it is checked
   * here by construction: there is nothing else to wrap.
   */
  async function addPasskey() {
    const dek = getDek()
    if (!dek) throw new Error('Unlock first: adding a passkey needs the key it is copying.')
    busy.value = true
    try {
      await registerKey(dek)
    } finally {
      busy.value = false
    }
  }

  /**
   * Remove a lost device's passkey. The server refuses the last one while any list is still
   * encrypted (409), and allows it when none is.
   *
   * When that was the last one, the DEK has to go with it. It is unrecoverable from this moment
   * — no wrapped copy exists anywhere — so keeping it in memory would let this session lock a
   * list under a key that nothing, on any device including this one after a reload, could ever
   * open again.
   */
  async function removePasskey(credentialId) {
    await api.del(`encryption?credential_id=${encodeURIComponent(credentialId)}`)
    await load()

    if (!keys.value.length) {
      clearDek()
      unlocked.value = false
    }
  }

  /** On logout: the key, the cached blobs and the flags all belong to the account leaving. */
  function reset() {
    clearDek()
    unlocked.value = false
    keys.value = []
    ready.value = false
    try {
      localStorage.removeItem(cacheKeyFor(uid()))
    } catch {
      // See `writeCache`.
    }
  }

  return {
    keys,
    ready,
    busy,
    enabled,
    locked,
    unlocked,
    load,
    createKey,
    unlock,
    addPasskey,
    removePasskey,
    reset,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useEncryptionStore, import.meta.hot))
}
