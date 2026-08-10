import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { installLocalStorage, makeServer } from './fakeServer'
import { generateDek } from 'src/utils/crypto'
import { clearDek, setDek } from 'src/stores/shoppingLists/encryption'

vi.mock('src/stores/auth', () => ({
  useAuthStore: () => ({ user: { uid: 'user-1' }, retrySync: async () => {} }),
}))

const { useShoppingListsStore } = await import('src/stores/shoppingLists')

/**
 * The encryption seam, exercised through the store rather than around it
 * (`docs/go_encrypted.md` §4, §9).
 *
 * These tests drive the real `src/api.js` against the fake server, so what they assert about
 * "what was sent" is the actual request body. That matters more here than anywhere else in the
 * suite: the whole claim of this feature is that plaintext does not leave the device, and the
 * only honest way to check it is to read the bytes that went over the wire.
 *
 * **Encryption is per list** (§1). Holding a key does not make this device encrypt anything —
 * each list carries its own `encrypted` flag, and the seam reads that and nothing else. So
 * nearly every test here works on two lists: one locked, one ordinary, in the same store and
 * the same session.
 */
describe('the encryption seam', () => {
  let server

  beforeEach(async () => {
    installLocalStorage()
    setActivePinia(createPinia())
    server = makeServer()
    server.install()
    setDek(await generateDek())
  })

  afterEach(() => {
    // Otherwise the key leaks into the next test and "locked" cases silently pass.
    clearDek()
  })

  /**
   * Request bodies as one string to search for leaks, optionally only those sent after a
   * given point.
   *
   * The `from` argument exists because of §8: a list that was plaintext and is locked later
   * was already sent in the clear, and no amount of encryption afterwards recalls it. So the
   * honest claim is about everything written *from the lock onwards*, and that is what these
   * tests measure. `sentSoFar()` marks the line.
   */
  const everythingSent = (from = 0, to = undefined) =>
    server.sent
      .slice(from, to)
      .map((s) => s.raw)
      .join('\n')

  const sentSoFar = () => server.sent.length

  const bodyOf = (method, path) =>
    JSON.parse(server.sent.filter((s) => s.method === method && s.path === path).at(-1).raw)

  /** Create a list on the server and open it. Plaintext, as every list starts out. */
  async function openNew(title, items) {
    const store = useShoppingListsStore()
    store.importLists([{ title, items }])
    await store.sync()
    const record = store.lists.at(-1)
    // By local id: a list created here keeps its `tmp-N` identity and only gains a `serverId`.
    await store.open(record.id)

    return { store, record }
  }

  /**
   * The same, then locked — the whole of "encrypt this list" as the UI does it.
   *
   * `lockedAt` is where in `server.sent` the locking write begins, so a test can talk about
   * what left the device after that and not before (see `everythingSent`).
   */
  async function openLocked(title, items) {
    const opened = await openNew(title, items)
    const lockedAt = sentSoFar()
    await opened.store.setEncrypted(true)

    return { ...opened, lockedAt }
  }

  describe('pushing', () => {
    it('encrypts the items of a locked list, and sends no plaintext from then on', async () => {
      const { store, lockedAt } = await openLocked('Секретный список', ['водка', 'селёдка'])

      store.beginEdit()
      store.setName(0, 'самогон')
      store.endEdit()
      await store.flush()

      const sent = everythingSent(lockedAt)
      for (const secret of ['водка', 'селёдка', 'самогон']) expect(sent).not.toContain(secret)

      const put = bodyOf('PUT', 'shopping-list')
      expect(put.encrypted).toBe(true)
      expect(put.items.map((i) => i.name)).not.toContain('самогон')
    })

    it('does not unsend what the server already had — locking is not retroactive (§8)', async () => {
      const { lockedAt } = await openLocked('Секретный список', ['водка'])

      // Stated as a test because it is the one thing about per-list encryption that is easy to
      // get wrong in one's head: locking a list protects it from here on. The copy that was
      // already sent went in the clear, and on a real server it survives in the old row
      // version until a vacuum, and in any backup taken before it.
      expect(everythingSent(0, lockedAt)).toContain('водка')
      // What it does do: the current stored value is ciphertext.
      expect(server.lists[0].items[0].name).not.toBe('водка')
    })

    it('leaves the title in the clear, which is the deal (§1)', async () => {
      await openLocked('Секретный список', ['водка'])

      // Not an oversight: the index has to render every title with no key, so the app opens
      // and works without a prompt. The server learns *that* there is a list called this, and
      // nothing about what is in it.
      expect(bodyOf('PUT', 'shopping-list').name).toBe('Секретный список')
      expect(server.lists[0].name).toBe('Секретный список')
    })

    it('leaves a blank quantity as null rather than encrypting nothing', async () => {
      await openLocked('Список', ['молоко'])

      expect(bodyOf('PUT', 'shopping-list').items[0].quantity).toBeNull()
    })

    it('sends an ordinary list in the clear, key or no key', async () => {
      const { store } = await openNew('Groceries', ['milk'])

      store.beginEdit()
      store.setName(0, 'milk and bread')
      store.endEdit()
      await store.flush()

      // This is the whole point of keying the seam on the list: a device holding a key writes
      // the shopping list in the clear and the private one sealed, in the same session.
      const put = bodyOf('PUT', 'shopping-list')
      expect(put.name).toBe('Groceries')
      expect(put.items[0].name).toBe('milk and bread')
      expect(put.encrypted).toBe(false)
    })

    it('creates every list plaintext, whatever this device is holding', async () => {
      const store = useShoppingListsStore()
      await store.createList('Groceries')

      // A new list cannot be the private one yet — nothing is in it. Encrypting on creation
      // would put a fingerprint prompt in front of the most ordinary thing the app does.
      const post = bodyOf('POST', 'shopping-lists')
      expect(post.name).toBe('Groceries')
      expect(post.encrypted).toBeUndefined()
      expect(store.lists[0].encrypted).toBe(false)
    })

    it('states the flag when a list stops being encrypted, and writes it back readable', async () => {
      const { store } = await openLocked('Секретный список', ['водка'])

      await store.setEncrypted(false)

      // `sometimes` on the server means an absent flag leaves the old value alone, so turning
      // it off has to be said out loud or the row stays marked encrypted with plaintext in it.
      const put = bodyOf('PUT', 'shopping-list')
      expect(put.encrypted).toBe(false)
      expect(put.items[0].name).toBe('водка')
      expect(server.lists[0].encrypted).toBe(false)
    })
  })

  describe('reading back', () => {
    it('restores the items through the server', async () => {
      const { record } = await openLocked('Секретный список', ['водка', 'селёдка'])
      const serverId = record.serverId

      // A second store on the same fake server: a different device, or this one after a
      // restart. Nothing of the first store's memory is reused.
      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()
      await fresh.open(serverId)

      expect(fresh.items.map((i) => i.name)).toEqual(['водка', 'селёдка'])
      // And the server really is holding ciphertext, not merely reporting a flag.
      expect(server.lists[0].items[0].name).not.toBe('водка')
    })

    it('reads the whole index with no key at all', async () => {
      await openLocked('Секретный список', ['водка'])
      await openNew('Groceries', ['milk'])

      clearDek()
      setActivePinia(createPinia())
      const locked = useShoppingListsStore()
      await locked.fetchLists()

      // The property the whole design rests on: a locked device is a working app. Both titles,
      // both counts, and which of them is private — none of it needs a fingerprint.
      expect(locked.visibleLists.map((l) => l.name)).toEqual(['Секретный список', 'Groceries'])
      expect(locked.visibleLists.map((l) => l.items_count)).toEqual([1, 1])
      expect(locked.visibleLists.map((l) => l.encrypted)).toEqual([true, false])
    })

    it('opens an ordinary list while locked', async () => {
      const { record } = await openNew('Groceries', ['milk'])
      const serverId = record.serverId

      clearDek()
      setActivePinia(createPinia())
      const locked = useShoppingListsStore()
      await locked.fetchLists()
      await locked.open(serverId)

      // Nothing about holding no key should touch a list that was never encrypted — which is
      // every list, until somebody says otherwise.
      expect(locked.items.map((i) => i.name)).toEqual(['milk'])
    })

    it('refreshes a known list from the index without disturbing its flag', async () => {
      const { store } = await openLocked('Секретный список', ['водка'])

      // Second read of the same list: this goes down `applyIndexEntry`, a different path from
      // the first-sighting one above.
      await store.fetchLists()

      expect(store.visibleLists[0].name).toBe('Секретный список')
      expect(store.visibleLists[0].encrypted).toBe(true)
    })
  })

  /**
   * The features §4 promises are untouched: everything above the seam works on plaintext in
   * memory, so nothing about them should change when the strings arrive as ciphertext.
   *
   * They are tested here rather than trusted because they are exactly the ones that would break
   * quietly — a total that stops appearing, an undo that restores base64 — and because each one
   * reads `items` a beat after the seam has written them, which is where a regression would land.
   *
   * Search is the fourth of that family and is not here: it lives in `ShoppingListPage.vue` as a
   * predicate over these same `items`, and there is no component harness in this suite. It was
   * checked in the browser instead — see §9.
   */
  describe('above the seam', () => {
    /** Type into a row as `ShoppingListRow` does: focus, input, then the `change` on blur. */
    function editRow(store, index, value) {
      store.beginEdit()
      store.setName(index, value)
      store.endEdit()
    }

    const names = (store) => store.items.map((i) => i.name)

    /** A locked list, read back by a second device — so every row here came from ciphertext. */
    async function readBack(title, items) {
      const { record } = await openLocked(title, items)

      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()
      await fresh.open(record.serverId)

      return fresh
    }

    /**
     * The same, as a tally: a list of numbers is one with no quantity column — half of what
     * `numericTotal` requires. Asked rather than toggled blindly, because an imported list
     * already arrives without that column.
     */
    async function readBackTally(numbers) {
      const store = await readBack('Счёт', numbers)
      if (store.showQuantity) await store.toggleQuantity()

      return store
    }

    it('totals rows that arrived as ciphertext', async () => {
      const store = await readBackTally(['400_000', '600_000', ''])

      expect(server.lists[0].items[0].name).not.toBe('400_000')
      expect(store.numericTotal).toBe(1000000)
    })

    it('follows an edit to an encrypted list, and stops when it should', async () => {
      const store = await readBackTally(['10', '5'])

      editRow(store, 1, '6')
      expect(store.numericTotal).toBe(16)
      editRow(store, 1, 'шесть')
      expect(store.numericTotal).toBeNull()
    })

    it('squashes an encrypted tally and takes it back in one step', async () => {
      const store = await readBackTally(['400_000', '600_000'])

      store.squashRows()
      expect(names(store)).toEqual(['1_000_000'])
      store.undo()
      expect(names(store)).toEqual(['400_000', '600_000'])
    })

    it('undoes and redoes an edit on an encrypted list', async () => {
      const store = await readBack('Секретный список', ['водка', 'селёдка'])

      editRow(store, 0, 'вода')
      expect(names(store)).toEqual(['вода', 'селёдка'])
      store.undo()
      // The undo stack holds plaintext, because the seam is below it. A record of ciphertext
      // here would put base64 on screen — and then save it as an item name.
      expect(names(store)).toEqual(['водка', 'селёдка'])
      store.redo()
      expect(names(store)).toEqual(['вода', 'селёдка'])
    })

    it('sends what the undo restored, encrypted, and nothing else', async () => {
      const store = await readBack('Секретный список', ['водка', 'селёдка'])
      const serverId = store.lists[0].serverId
      const before = sentSoFar()
      editRow(store, 0, 'вода')
      store.undo()

      await store.flush()

      // Restoring a value and saving it is a write like any other: encrypted on the way out,
      // and the restored text — not the edit that was undone — is what a third device reads.
      expect(everythingSent(before)).not.toContain('водка')
      expect(bodyOf('PUT', 'shopping-list').encrypted).toBe(true)

      setActivePinia(createPinia())
      const third = useShoppingListsStore()
      await third.fetchLists()
      await third.open(serverId)
      expect(names(third)).toEqual(['водка', 'селёдка'])
    })
  })

  describe('a list encrypted under the old account-wide design', () => {
    it('opens its title and writes it back in the clear', async () => {
      const { store, record } = await openLocked('Секретный список', ['водка'])
      // Exactly what the previous design left behind: a locked list whose *title* is ciphertext
      // too. Written straight into the fake server, since no code path produces it any more.
      const { sealField } = await import('src/stores/shoppingLists/encryption')
      server.lists[0].name = await sealField('Секретный список')

      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()
      await fresh.open(record.serverId)

      // Readable again, and marked dirty so the next save heals it for every other device.
      expect(fresh.listName).toBe('Секретный список')
      expect(fresh.lists[0].dirty).toBe(true)

      await fresh.sync()
      expect(server.lists[0].name).toBe('Секретный список')
      expect(server.lists[0].encrypted).toBe(true)
      expect(store.lists[0].serverId).toBe(record.serverId)
    })

    it('leaves an ordinary plaintext title alone', async () => {
      // The `catch` in `healLegacyTitle` must mean "this was never encrypted", not "something
      // went wrong" — every locked list written since the change takes this path.
      const { record } = await openLocked('Секретный список', ['водка'])

      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()
      await fresh.open(record.serverId)

      expect(fresh.listName).toBe('Секретный список')
      expect(fresh.lists[0].dirty).toBe(false)
    })
  })

  describe('locked', () => {
    it('refuses to open an encrypted list rather than showing base64', async () => {
      const { record } = await openLocked('Секретный список', ['водка'])
      const serverId = record.serverId

      clearDek()
      setActivePinia(createPinia())
      const locked = useShoppingListsStore()
      await locked.fetchLists()

      // Passing the ciphertext through would look like a rendering bug and then be saved back
      // as an item name on the next write — silent corruption dressed as a cosmetic problem.
      // The page turns this into a fingerprint prompt; it must not turn into rows.
      await expect(locked.open(serverId)).rejects.toThrow(/encrypted/i)
    })

    it('holds a pending edit back rather than writing plaintext over an encrypted list', async () => {
      const { store, record } = await openLocked('Секретный список', ['водка'])
      const before = JSON.stringify(server.lists[0])

      // The scenario with no UI to blame: an edit made offline is still `dirty` after a
      // restart, and the first sync fires before the fingerprint prompt is answered.
      record.items[0].name = 'селёдка'
      record.dirty = true
      clearDek()

      await store.sync()

      // Sending it would leave plaintext under a list still flagged `encrypted` — unreadable
      // on every other device, and on the server until a vacuum (§8). So: nothing written,
      // the edit still pending, and it goes out after the unlock instead.
      expect(JSON.stringify(server.lists[0])).toBe(before)
      expect(record.dirty).toBe(true)
    })
  })
})
