import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { installLocalStorage, makeServer } from './fakeServer'
import { decryptField, generateDek } from 'src/utils/crypto'
import { clearDek, getDek, setDek } from 'src/stores/shoppingLists/encryption'

vi.mock('src/stores/auth', () => ({
  useAuthStore: () => ({ user: { uid: 'user-1' }, retrySync: async () => {} }),
}))

const { useShoppingListsStore } = await import('src/stores/shoppingLists')

/**
 * Turning encryption on, and being interrupted while doing it (`docs/go_encrypted.md` §9).
 *
 * The pass is one write per list, so on a phone it will be interrupted — a tunnel, a locked
 * screen, a killed PWA. What these tests pin is that stopping is *boring*: no list is left
 * half-converted, what remains is a query rather than remembered state, and running it again
 * finishes the job. That is the per-list flag from §5 earning its place; without it the state
 * below would be unreadable and the only safe move after a failure would be to re-encrypt
 * everything and hope.
 */
describe('turning encryption on', () => {
  let server

  beforeEach(async () => {
    installLocalStorage()
    setActivePinia(createPinia())
    server = makeServer()
    server.install()
    setDek(await generateDek())
  })

  afterEach(() => {
    clearDek()
  })

  /** Three lists already on the server, as an existing user would have. */
  const seedPlaintext = () => {
    server.seed('Groceries', [{ name: 'milk' }, { name: 'bread' }])
    server.seed('Hardware', [{ name: 'nails' }])
    server.seed('Пятёрочка', [{ name: 'водка' }])
  }

  /**
   * Every list as the server holds it, read according to its own flag.
   *
   * This is the assertion that matters most: a list whose flag says encrypted must actually be
   * ciphertext, and a list whose flag says plaintext must actually be readable. Anything else is
   * the unreadable state the flag exists to prevent, and it would show up here as a rejection.
   */
  const readServerAsFlagged = async () =>
    Promise.all(
      server.lists.map(async (l) => ({
        name: l.encrypted ? await decryptField(l.name, getDek()) : l.name,
        items: await Promise.all(
          l.items.map((i) => (l.encrypted ? decryptField(i.name, getDek()) : i.name)),
        ),
        encrypted: l.encrypted,
      })),
    )

  it('converts every list', async () => {
    seedPlaintext()
    const store = useShoppingListsStore()
    await store.fetchLists()

    const result = await store.encryptAll()

    expect(result).toEqual({ total: 3, done: 3, stopped: null })
    expect(server.lists.every((l) => l.encrypted)).toBe(true)
    expect((await readServerAsFlagged()).map((l) => l.name)).toEqual([
      'Groceries',
      'Hardware',
      'Пятёрочка',
    ])
  })

  it('loads the items of a list the user never opened, instead of blanking it', async () => {
    seedPlaintext()
    const store = useShoppingListsStore()
    // Straight from the index: every record has `items: null`, meaning unread rather than empty.
    await store.fetchLists()
    expect(store.lists.every((l) => l.items == null)).toBe(true)

    await store.encryptAll()

    // The trap this avoids: pushing an unread record PUTs an empty item set over real rows, and
    // the pass is the one thing that touches lists nobody has opened.
    expect((await readServerAsFlagged()).map((l) => l.items)).toEqual([
      ['milk', 'bread'],
      ['nails'],
      ['водка'],
    ])
  })

  describe('interrupted midway', () => {
    it('stops cleanly and reports how far it got', async () => {
      seedPlaintext()
      const store = useShoppingListsStore()
      await store.fetchLists()
      // Two writes get through — one list's worth — then the connection dies.
      server.offlineAfterWrites(2)

      const result = await store.encryptAll()

      expect(result.stopped).toBe('offline')
      expect(result.total).toBe(3)
      // One write per list, so two got through. Asserted exactly rather than "fewer than
      // three": a pass that reported 0 done would also satisfy that, while meaning something
      // completely different happened.
      expect(result.done).toBe(2)
    })

    it('leaves no list half-converted', async () => {
      seedPlaintext()
      const store = useShoppingListsStore()
      await store.fetchLists()
      server.offlineAfterWrites(2)

      await store.encryptAll()

      // A mixture is expected. What must not exist is a list whose flag disagrees with its
      // content — this rejects if any encrypted-flagged list is holding plaintext.
      const rows = await readServerAsFlagged()
      expect(rows.some((l) => l.encrypted)).toBe(true)
      expect(rows.some((l) => !l.encrypted)).toBe(true)
      expect(rows.map((l) => l.name)).toEqual(['Groceries', 'Hardware', 'Пятёрочка'])
    })

    it('finishes the job when run again', async () => {
      seedPlaintext()
      const store = useShoppingListsStore()
      await store.fetchLists()
      server.offlineAfterWrites(2)
      const first = await store.encryptAll()

      // The connection comes back. Nothing was remembered about the first attempt.
      server.offline = false
      server.writesLeft = null
      const second = await store.encryptAll()

      expect(second.stopped).toBeNull()
      expect(first.done + second.done).toBe(3)
      expect(server.lists.every((l) => l.encrypted)).toBe(true)
      expect((await readServerAsFlagged()).map((l) => l.name)).toEqual([
        'Groceries',
        'Hardware',
        'Пятёрочка',
      ])
    })

    it('does not rewrite the lists it already converted', async () => {
      seedPlaintext()
      const store = useShoppingListsStore()
      await store.fetchLists()
      server.offlineAfterWrites(2)
      await store.encryptAll()
      const doneIds = server.lists.filter((l) => l.encrypted).map((l) => l.id)
      const versionsBefore = new Map(server.lists.map((l) => [l.id, l.version]))

      server.offline = false
      server.writesLeft = null
      await store.encryptAll()

      // Re-encrypting a finished list would work, but it would also bump its version and
      // invalidate other devices' pending edits for no reason — and on a real collection it
      // would double the work of every resume.
      for (const id of doneIds) {
        const list = server.lists.find((l) => l.id === id)
        expect(list.version).toBe(versionsBefore.get(id))
      }
    })

    it('has nothing left to do once every list is converted', async () => {
      seedPlaintext()
      const store = useShoppingListsStore()
      await store.fetchLists()
      await store.encryptAll()

      // "What is left" is a query over the flag, not progress this had to persist.
      expect(store.notYetEncrypted()).toEqual([])
      expect(await store.encryptAll()).toEqual({ total: 0, done: 0, stopped: null })
    })
  })

  it('refuses to run without a key rather than flagging everything plaintext', async () => {
    seedPlaintext()
    const store = useShoppingListsStore()
    await store.fetchLists()
    clearDek()

    // A pass with no key would push every list back unchanged and flag none — a no-op that
    // looks exactly like a completed conversion.
    await expect(store.encryptAll()).rejects.toThrow(/no data key/i)
    expect(server.lists.some((l) => l.encrypted)).toBe(false)
  })

  it('skips a list that is tombstoned rather than encrypting what is being deleted', async () => {
    seedPlaintext()
    const store = useShoppingListsStore()
    await store.fetchLists()
    const doomed = store.lists[1]
    server.offline = true
    await store.deleteList(doomed.id)
    server.offline = false

    await store.encryptAll()

    // It is on its way out; a write to it would only race the tombstone.
    expect(server.lists.find((l) => l.id === doomed.serverId).encrypted).toBe(false)
  })
})
