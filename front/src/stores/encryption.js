import { defineStore, acceptHMRUpdate } from 'pinia'
import { api, isNetworkError } from 'src/api'
import { deriveKek, generateDek, randomSalt, unwrapDek, wrapDek } from 'src/utils/crypto'
import {
  hasPlatformAuthenticator,
  isPasskeySupported,
  passkeyPrf,
  registerPasskey,
} from 'src/utils/passkey'
import { useAuthStore } from 'src/stores/auth'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { clearDek, getDek, isUnlocked, setDek } from 'src/stores/shoppingLists/encryption'
import { useTrashStore } from 'src/stores/trash'

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

export const useEncryptionStore = defineStore('encryption', {
  state: () => ({
    /** One row per registered passkey: `{ credential_id, hkdf_salt, wrapped_key, created_at }`. */
    keys: readCache(useAuthStore().user?.uid),
    /** Whether the question "is encryption on?" has been answered yet, from cache or server. */
    ready: false,
    /** Mirrors the module-level key, so the UI can react to it. */
    unlocked: isUnlocked(),
    busy: false,
    /**
     * Whether this device has a built-in authenticator — a fingerprint reader, a face camera,
     * a screen lock — as opposed to only being able to use a separate security key.
     *
     * `null` until asked, which is not the same as `false`: the setup screen warns on `false`,
     * and starting there would flash a warning at every device for as long as the query takes.
     */
    platformAuthenticator: null,
  }),

  getters: {
    /** There is a key for this account. Says nothing about any particular list. */
    enabled: (state) => state.keys.length > 0,

    /**
     * There is a key and this session has not opened it — so an encrypted list cannot be read
     * yet. Nothing acts on this by itself: it is what the editor checks when it is asked for a
     * list the server holds encrypted, and nowhere else.
     */
    locked() {
      return this.enabled && !this.unlocked
    },
  },

  actions: {
    _uid() {
      return useAuthStore().user?.uid
    },

    /**
     * How many lists this key is currently the way into.
     *
     * Which lists are encrypted belongs to the lists (§1) and this store deliberately does not
     * track it — but "may this passkey be removed" cannot be answered without it, so this is
     * the one question it asks across.
     *
     * **The trash counts too.** A trashed list is recoverable for the whole retention window and
     * comes back with its rows exactly as they were, ciphertext included — so a key removed
     * while it sits there would make the restore hand back a list that nothing can ever open,
     * which is the one outcome this rule exists to prevent. The server counts them the same way
     * (`withTrashed()` in `EncryptionController::destroy`), which is the count that decides.
     *
     * This one can be lower, on purpose and by accident, so it stays a warning rather than a
     * verdict: a list deleted here and not yet pushed is out of `visibleLists` while the server
     * still holds it, a list queued for purge is left out deliberately, and a device that has
     * never opened the trash has nothing cached to count. The button says what it can; the 409
     * is what refuses.
     *
     * An action rather than a getter on purpose: nothing renders it, both callers want it at
     * the moment of a tap, and a getter would create the lists store — and run its
     * hydration — from inside a computed.
     */
    lockedListCount() {
      return useShoppingListsStore().encryptedCount + useTrashStore().encryptedCount
    },

    /**
     * Whether this passkey is the only thing that can still open a locked list.
     *
     * The server enforces the same rule and is the one that matters (409); this is here so the
     * button can say what it will do before it is pressed. With nothing locked the last passkey
     * is removable — a key that opens nothing is not protecting anything.
     */
    isLastWayIn() {
      return this.keys.length < 2 && this.lockedListCount() > 0
    },

    /** Asked once per session, the first time a setup screen is opened. */
    async checkPlatformAuthenticator() {
      if (this.platformAuthenticator !== null) return
      this.platformAuthenticator = await hasPlatformAuthenticator()
    },

    _remember(rows) {
      this.keys = rows
      writeCache(this._uid(), rows)
    },

    /**
     * Find out whether encryption is on. Called on boot, before anything tries to read a list.
     *
     * Falls back to the cache when the server cannot be reached, because "we could not ask" must
     * not read as "encryption is off" — that would send the app straight into showing ciphertext
     * as list names.
     */
    async load() {
      try {
        const { data } = await api.get('encryption')
        this._remember(data ?? [])
      } catch (err) {
        // 401 lands here too: nothing is known about this user yet, so the cache is all there is.
        if (!isNetworkError(err) && err.status !== 401) throw err
      } finally {
        this.ready = true
      }
    },

    /**
     * The one refusal worth making before a passkey prompt rather than after it.
     *
     * Only the missing API is fatal. A device with no built-in authenticator is merely unusual —
     * a USB security key satisfies WebAuthn too — so `hasPlatformAuthenticator` is left to the
     * setup screen to warn about rather than checked here.
     */
    _assertPasskeySupport() {
      if (!isPasskeySupported()) {
        throw new Error('This browser cannot use passkeys, so it cannot encrypt your lists.')
      }
    },

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
    async _registerKey(dek) {
      const user = useAuthStore().user
      const { credentialId, prf } = await registerPasskey({
        userId: this._uid() ?? 'local',
        userName: user?.email ?? 'Shopping list',
        displayName: user?.displayName ?? user?.email ?? 'Shopping list',
      })

      const hkdf_salt = randomSalt()
      const kek = await deriveKek(prf, hkdf_salt)
      const wrapped_key = await wrapDek(dek, kek)

      await api.put('encryption', { credential_id: credentialId, hkdf_salt, wrapped_key })
      await this.load()

      return credentialId
    },

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
    async createKey() {
      if (this.enabled) throw new Error('This account already has an encryption key.')
      this.busy = true
      try {
        this._assertPasskeySupport()

        const dek = await generateDek()
        await this._registerKey(dek)

        // Only after the server has the wrapped copy — see above.
        setDek(dek)
        this.unlocked = true
      } finally {
        this.busy = false
      }
    },

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
    async unlock() {
      if (!this.enabled) return
      this.busy = true
      try {
        const { credentialId, prf } = await passkeyPrf(this.keys.map((k) => k.credential_id))

        // A resident-credential prompt can return a passkey this account has no wrapped copy
        // for — another account's, on a shared device.
        const row = this.keys.find((k) => k.credential_id === credentialId)
        if (!row) throw new Error('That passkey is not registered for these lists.')

        const kek = await deriveKek(prf, row.hkdf_salt)
        setDek(await unwrapDek(row.wrapped_key, kek))

        const lists = useShoppingListsStore()
        try {
          // Edits to an encrypted list made before the key arrived were held back rather than
          // written in the clear (`payloadOf`), and this is the trigger that knows they can go.
          // Awaiting it now waits for the pass rather than returning on a flag: a pass another
          // trigger has already started is joined rather than skipped, so `fetchLists` below
          // cannot overlap one. Ordering is what that guarantees, not an empty queue — a pass
          // that has already stopped on this very list leaves its edit for the next trigger.
          await lists.sync()
          // Cheap, and it settles the collection before the editor reacts — see above.
          await lists.fetchLists()
        } catch (err) {
          // Offline is not a failed unlock — the key is here and the cache is what the user is
          // already looking at. Anything else is worth surfacing, but not by staying locked.
          if (!isNetworkError(err)) throw err
        } finally {
          this.unlocked = true
        }
      } finally {
        this.busy = false
      }
    },

    /**
     * Give a second passkey access to the same data key — §1's entire recovery story, and the
     * only way to read these lists on a device the first passkey does not sync to.
     *
     * Unlocks first when this session is not already holding the key, because the DEK being
     * wrapped has to be the one every list is already encrypted under — so it has to be in hand,
     * and there is no version of this that works without it. Nothing unlocks at boot any more
     * (§1), so on most visits this is two prompts in a row: one to open the key, one to create
     * the credential. Doing it here rather than telling the caller to go and open a locked list
     * first is the difference between a working button and a dead end.
     *
     * The server cannot check that the copy wraps the right key (§5), so it is checked here by
     * construction: after the unlock there is nothing else to wrap.
     */
    async addPasskey() {
      if (!this.unlocked) await this.unlock()

      const dek = getDek()
      if (!dek) throw new Error('Unlock first: adding a passkey needs the key it is copying.')
      this.busy = true
      try {
        await this._registerKey(dek)
      } finally {
        this.busy = false
      }
    },

    /**
     * Remove a lost device's passkey. The server refuses the last one while any list is still
     * encrypted (409), and allows it when none is.
     *
     * When that was the last one, the DEK has to go with it. It is unrecoverable from this moment
     * — no wrapped copy exists anywhere — so keeping it in memory would let this session lock a
     * list under a key that nothing, on any device including this one after a reload, could ever
     * open again.
     */
    async removePasskey(credentialId) {
      await api.del(`encryption?credential_id=${encodeURIComponent(credentialId)}`)
      await this.load()

      if (!this.keys.length) {
        clearDek()
        this.unlocked = false
      }
    },

    /** On logout: the key, the cached blobs and the flags all belong to the account leaving. */
    reset() {
      clearDek()
      this.unlocked = false
      this.keys = []
      this.ready = false
      try {
        localStorage.removeItem(cacheKeyFor(this._uid()))
      } catch {
        // See `writeCache`.
      }
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useEncryptionStore, import.meta.hot))
}
