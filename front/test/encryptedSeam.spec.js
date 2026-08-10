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

  /** Every request body sent so far, as one string to search for leaks. */
  const everythingSent = () => server.sent.map((s) => s.raw).join('\n')

  const bodyOf = (method, path) =>
    JSON.parse(server.sent.filter((s) => s.method === method && s.path === path).at(-1).raw)

  describe('pushing', () => {
    it('sends ciphertext and never the plaintext', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Секретный список', items: ['водка', 'селёдка'] }])

      await store.sync()

      const sent = everythingSent()
      // The point of the whole feature, as one assertion per string the user typed.
      for (const secret of ['Секретный список', 'водка', 'селёдка']) {
        expect(sent).not.toContain(secret)
      }
      const put = bodyOf('PUT', 'shopping-list')
      expect(put.encrypted).toBe(true)
      expect(put.name).not.toBe('Секретный список')
      expect(put.items.map((i) => i.name)).not.toContain('водка')
    })

    it('encrypts the name on the create request too, not just the update', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Секретный список', items: ['водка'] }])

      await store.sync()

      // A plaintext name sent here and corrected a moment later would still be on disk:
      // Postgres keeps the old row version until it is vacuumed (§8).
      const post = bodyOf('POST', 'shopping-lists')
      expect(post.name).not.toBe('Секретный список')
      expect(post.encrypted).toBe(true)
    })

    it('leaves a blank quantity as null rather than encrypting nothing', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Список', items: ['молоко'] }])

      await store.sync()

      expect(bodyOf('PUT', 'shopping-list').items[0].quantity).toBeNull()
    })

    it('sends plaintext and no flag when this device has no key', async () => {
      clearDek()
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Groceries', items: ['milk'] }])

      await store.sync()

      const put = bodyOf('PUT', 'shopping-list')
      // Encryption being off has to look exactly like the app before any of this existed —
      // including the absence of the flag, so an untouched list is not relabelled.
      expect(put.name).toBe('Groceries')
      expect(put.encrypted).toBeUndefined()
    })
  })

  describe('reading back', () => {
    it('restores what it sent, through the server', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Секретный список', items: ['водка', 'селёдка'] }])
      await store.sync()
      const serverId = store.lists[0].serverId

      // A second store on the same fake server: a different device, or this one after a
      // restart. Nothing of the first store's memory is reused.
      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()
      await fresh.open(serverId)

      expect(fresh.listName).toBe('Секретный список')
      expect(fresh.items.map((i) => i.name)).toEqual(['водка', 'селёдка'])
      // And the server really is holding ciphertext, not merely reporting a flag.
      expect(server.lists[0].name).not.toBe('Секретный список')
    })

    it('decrypts the index name, not only the full read', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Секретный список', items: ['водка'] }])
      await store.sync()

      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()

      // The index page renders this name without ever opening the list.
      expect(fresh.visibleLists[0].name).toBe('Секретный список')
    })

    it('refreshes an already-known list from the index without garbling its name', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Секретный список', items: ['водка'] }])
      await store.sync()

      // Second read of the same list: this goes down `applyIndexEntry`, which is a different
      // path from the first-sighting one above and decrypts separately.
      await store.fetchLists()

      expect(store.visibleLists[0].name).toBe('Секретный список')
    })
  })

  describe('a collection that is only partly encrypted', () => {
    it('reads each list according to its own flag', async () => {
      // Exactly the state a half-finished enable leaves behind, and the reason the flag is
      // per list rather than per user.
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Уже зашифровано', items: ['водка'] }])
      await store.sync()
      const encryptedId = store.lists[0].serverId

      const plain = server.seed('Ещё не зашифровано', [{ name: 'молоко' }])

      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()

      expect(fresh.visibleLists.map((l) => l.name).sort()).toEqual(
        ['Ещё не зашифровано', 'Уже зашифровано'].sort(),
      )

      await fresh.open(encryptedId)
      expect(fresh.items.map((i) => i.name)).toEqual(['водка'])

      await fresh.open(plain.id)
      expect(fresh.items.map((i) => i.name)).toEqual(['молоко'])
    })

    it('encrypts a list that was still plaintext on its next push', async () => {
      // The enable pass is nothing more than this: push every list, and the seam does the rest.
      const plain = server.seed('Ещё не зашифровано', [{ name: 'молоко' }])
      const store = useShoppingListsStore()
      await store.fetchLists()
      await store.open(plain.id)
      // The sequence `ShoppingListRow` uses: focus, type, blur. `endEdit` is what commits the
      // undo snapshot and schedules the save.
      store.beginEdit()
      store.setName(0, 'молоко и хлеб')
      store.endEdit()
      await store.flush()

      expect(server.lists[0].encrypted).toBe(true)
      expect(server.lists[0].name).not.toBe('Ещё не зашифровано')
      expect(everythingSent()).not.toContain('молоко и хлеб')
      // And the record now describes what the server holds, without waiting for a re-read.
      expect(store.lists[0].encrypted).toBe(true)
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

    /** A list pushed as ciphertext and read back by a second device, which is the point. */
    async function readBack(title, items) {
      const store = useShoppingListsStore()
      store.importLists([{ title, items }])
      await store.sync()
      const serverId = store.lists[0].serverId

      setActivePinia(createPinia())
      const fresh = useShoppingListsStore()
      await fresh.fetchLists()
      await fresh.open(serverId)

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
      editRow(store, 0, 'вода')
      store.undo()

      await store.flush()

      // Restoring a value and saving it is a write like any other: encrypted on the way out,
      // and the restored text — not the edit that was undone — is what a third device reads.
      expect(everythingSent()).not.toContain('водка')
      expect(bodyOf('PUT', 'shopping-list').encrypted).toBe(true)

      const serverId = store.lists[0].serverId
      setActivePinia(createPinia())
      const third = useShoppingListsStore()
      await third.fetchLists()
      await third.open(serverId)
      expect(names(third)).toEqual(['водка', 'селёдка'])
    })
  })

  describe('locked', () => {
    it('refuses to read an encrypted list rather than showing base64', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Секретный список', items: ['водка'] }])
      await store.sync()

      clearDek()
      setActivePinia(createPinia())
      const locked = useShoppingListsStore()

      // Passing the ciphertext through would look like a rendering bug and then be saved back
      // as a name on the next write — silent corruption dressed as a cosmetic problem.
      await expect(locked.fetchLists()).rejects.toThrow(/encrypted/i)
    })

    it('holds a pending edit back rather than writing plaintext over an encrypted list', async () => {
      const store = useShoppingListsStore()
      store.importLists([{ title: 'Секретный список', items: ['водка'] }])
      await store.sync()
      const before = JSON.stringify(server.lists[0])

      // The scenario with no UI to blame: an edit made offline is still `dirty` after a
      // restart, and the first sync fires before the fingerprint prompt is answered.
      const record = store.lists[0]
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

    it('still reads plaintext lists while locked', async () => {
      clearDek()
      server.seed('Groceries', [{ name: 'milk' }])
      const store = useShoppingListsStore()

      // Nothing about being locked should break a collection that was never encrypted — this
      // is every existing user until they turn it on.
      await store.fetchLists()
      expect(store.visibleLists[0].name).toBe('Groceries')
    })
  })
})
