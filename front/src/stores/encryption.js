import { computed, ref } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { api, isNetworkError } from 'src/api'
import { deriveKek, generateDek, randomSalt, unwrapDek, wrapDek } from 'src/utils/crypto'
import { isPasskeySupported, passkeyPrf, registerPasskey } from 'src/utils/passkey'
import { useAuthStore } from 'src/stores/auth'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { clearDek, getDek, isUnlocked, setDek } from 'src/stores/shoppingLists/encryption'

/**
 * Turning encryption on, and opening it again afterwards — §6's flows.
 *
 * This store owns everything *about* the key: which passkeys can open the lists, whether this
 * session has the data key yet, and the two long operations (enable, unlock). It deliberately
 * does not own the key itself — that lives in a module variable in
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

  /** One row per registered passkey: `{ credential_id, label, hkdf_salt, wrapped_key }`. */
  const keys = ref(readCache(uid()))
  /** Whether the question "is encryption on?" has been answered yet, from cache or server. */
  const ready = ref(false)
  /** Mirrors the module-level key, so the UI can react to it. */
  const unlocked = ref(isUnlocked())
  /** `{ total, done }` while the enable pass runs, null otherwise. */
  const progress = ref(null)
  const busy = ref(false)

  const enabled = computed(() => keys.value.length > 0)
  /** Set up, but this session cannot read anything — what puts the unlock screen up. */
  const locked = computed(() => enabled.value && !unlocked.value)
  /** §10's nag: one passkey is one lost phone away from losing everything. */
  const needsSecondPasskey = computed(() => keys.value.length === 1)

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
   * Wrap the data key for one credential and store it. Shared by "turn it on" and "add another
   * passkey", because they differ only in where the DEK came from.
   */
  async function registerKey(dek, label) {
    const { credentialId, prf } = await registerPasskey({
      userId: uid() ?? 'local',
      userName: auth.user?.email ?? 'Shopping list',
      displayName: auth.user?.displayName ?? auth.user?.email ?? 'Shopping list',
    })

    const hkdf_salt = randomSalt()
    const kek = await deriveKek(prf, hkdf_salt)
    const wrapped_key = await wrapDek(dek, kek)

    await api.put('encryption', { credential_id: credentialId, label, hkdf_salt, wrapped_key })
    await load()

    return credentialId
  }

  /**
   * Switch encryption on: one new passkey, one new data key, then every list rewritten.
   *
   * Needs a connection and says so up front — half the work is server writes, and a pass that
   * cannot reach the server converts nothing. It is still safe to be interrupted after that
   * point (see `encryptionPass.js`), so this reports where it got to instead of throwing.
   *
   * The lists are flushed first: the pass bumps every list's `version`, so an edit still
   * queued on another device would lose to a 409 afterwards (§6).
   */
  async function enable(label) {
    if (enabled.value) throw new Error('Encryption is already on for this account.')
    busy.value = true
    try {
      assertPasskeySupport()

      const lists = useShoppingListsStore()
      await lists.sync()

      const dek = await generateDek()
      await registerKey(dek, label)

      // Only now: a key this device holds but the server has no wrapped copy of would encrypt
      // lists that nothing could ever open again.
      setDek(dek)
      unlocked.value = true

      return await runPass()
    } finally {
      busy.value = false
    }
  }

  /**
   * Convert whatever is still plaintext. Exposed on its own because an interrupted enable is
   * resumed by running it again — there is no other state to restore.
   */
  async function runPass() {
    const lists = useShoppingListsStore()
    progress.value = { total: lists.notYetEncrypted().length, done: 0 }
    const result = await lists.encryptAll()
    // Left in place after it finishes so the screen can say how many were converted; the
    // dialog clears it when it closes.
    progress.value = { total: result.total, done: result.done }

    return result
  }

  /**
   * Open the lists on this device: one fingerprint prompt, one unwrap, then catch up.
   *
   * Works offline — the authenticator is local and the wrapped copy is cached. The wrong
   * credential does not need detecting: its KEK fails at the GCM tag inside `unwrapDek`.
   *
   * **The catching up happens before `unlocked` flips, and the order is load-bearing.** The
   * flag is what the screens watch to know the app is usable again, and `fetchLists` rebuilds
   * the collection wholesale — so a page that reacted to the flag by opening a list would race
   * that rebuild and have its freshly fetched items replaced by an index entry that carries
   * none. Flipping last means everything downstream reacts to a collection that has settled.
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
        // Anything edited before the key arrived was held back rather than written in the
        // clear (`payloadOf`), and this is the trigger that knows it can go now.
        await lists.sync()
        // What was on screen was read while locked: the plaintext cache, or nothing at all.
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
  async function addPasskey(label) {
    const dek = getDek()
    if (!dek) throw new Error('Unlock first: adding a passkey needs the key it is copying.')
    busy.value = true
    try {
      await registerKey(dek, label)
    } finally {
      busy.value = false
    }
  }

  /** Remove a lost device's passkey. The server refuses the last one (409). */
  async function removePasskey(credentialId) {
    await api.del(`encryption?credential_id=${encodeURIComponent(credentialId)}`)
    await load()
  }

  /** On logout: the key, the cached blobs and the flags all belong to the account leaving. */
  function reset() {
    clearDek()
    unlocked.value = false
    progress.value = null
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
    progress,
    enabled,
    locked,
    unlocked,
    needsSecondPasskey,
    load,
    enable,
    runPass,
    unlock,
    addPasskey,
    removePasskey,
    reset,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useEncryptionStore, import.meta.hot))
}
