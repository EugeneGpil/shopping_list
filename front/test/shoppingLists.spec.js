import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { installLocalStorage, makeServer } from './fakeServer'
import { notifications } from './stubs/quasar'

// The real auth store boots Firebase, which has no business in these tests. Only the two
// things the lists store asks of it are needed.
vi.mock('src/stores/auth', () => ({
  useAuthStore: () => ({ user: { uid: 'user-1' }, retrySync: async () => {} }),
}))

const { useShoppingListsStore } = await import('src/stores/shoppingLists')

// Longer than PERSIST_DEBOUNCE (300ms) in the store.
const settle = (ms = 380) => new Promise((r) => setTimeout(r, ms))

/**
 * Type into a row exactly as `ShoppingListRow` does: focus, then input, then the `change`
 * that fires on blur. The order matters — `beginEdit` is what takes the undo snapshot, and
 * `endEdit` is what commits it and schedules the save.
 */
function editRow(store, index, value) {
  store.beginEdit()
  store.setName(index, value)
  store.endEdit()
}

let server
let storage

/** A store instance with nothing carried over, as after a cold launch. */
function freshStore() {
  setActivePinia(createPinia())
  return useShoppingListsStore()
}

beforeEach(() => {
  storage = installLocalStorage()
  server = makeServer()
  server.install()
  notifications.length = 0
})

describe('reading offline', () => {
  it('serves a list from cache with no network at all', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)
    expect(store.items.map((i) => i.name)).toEqual(['Milk'])

    server.offline = true
    // Re-opening the same list must not need the network, and must not throw — throwing is
    // what used to eject the user to a home page that could not load either.
    await expect(store.open(seeded.id)).resolves.not.toThrow()
    expect(store.items.map((i) => i.name)).toEqual(['Milk'])
  })

  it('survives a restart: a new store rehydrates lists and items from localStorage', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const first = freshStore()
    await first.fetchLists()
    await first.open(seeded.id)
    await settle()
    expect([...storage.keys()]).toEqual(['shopping_lists:v1:user-1'])

    // Killed and relaunched with no connection: everything still readable.
    server.offline = true
    const second = freshStore()
    expect(second.visibleLists.map((l) => l.name)).toEqual(['Groceries'])
    await second.open(seeded.id)
    expect(second.items.map((i) => i.name)).toEqual(['Milk'])
  })

  it('reports a list it cannot reach and has never cached', async () => {
    const store = freshStore()
    server.offline = true
    await expect(store.open(99)).rejects.toThrow()
  })
})

describe('editing offline', () => {
  it('keeps an edit locally and pushes it on the next sync', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)

    server.offline = true
    editRow(store, 0, 'Oat milk')
    await store.flush()
    expect(store.saveStatus).toBe('Saved on this device')
    expect(store.pendingCount).toBe(1)
    expect(server.lists[0].items[0].name).toBe('Milk') // untouched, as expected

    server.offline = false
    await store.sync()
    expect(server.lists[0].items.map((i) => i.name)).toEqual(['Oat milk'])
    expect(store.pendingCount).toBe(0)
  })

  it('pushes an edit that survived a restart', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const first = freshStore()
    await first.fetchLists()
    await first.open(seeded.id)

    server.offline = true
    editRow(first, 0, 'Oat milk')
    await first.flush()
    await settle()

    // Relaunched, still offline, then the connection comes back.
    const second = freshStore()
    expect(second.pendingCount).toBe(1)
    server.offline = false
    await second.sync()
    expect(server.lists[0].items.map((i) => i.name)).toEqual(['Oat milk'])
    expect(second.pendingCount).toBe(0)
  })

  it('keeps a column toggle made offline instead of reverting it', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)

    server.offline = true
    await store.toggleQuantity()
    expect(store.showQuantity).toBe(false)

    server.offline = false
    await store.sync()
    expect(server.lists[0].show_quantity).toBe(false)
  })
})

async function openWith(names) {
  const seeded = server.seed(
    'Groceries',
    names.map((name) => ({ name })),
  )
  const store = freshStore()
  await store.fetchLists()
  await store.open(seeded.id)
  return store
}
const names = (store) => store.items.map((i) => i.name)

// What Enter does in the name field when there is no quantity column to move to. The
// caret positions are what `ShoppingListRow` reads off the textarea.
describe('splitting a row at the caret', () => {
  it('moves the text after the caret down, and leaves the rest', async () => {
    const store = await openWith(['Oat milk'])
    store.splitRow(0, 3, 3)
    expect(names(store)).toEqual(['Oat', ' milk'])
  })

  it('pushes the whole text down when the caret is at the start', async () => {
    const store = await openWith(['Milk'])
    store.splitRow(0, 0, 0)
    expect(names(store)).toEqual(['', 'Milk'])
  })

  it('adds an empty row when the caret is at the end', async () => {
    const store = await openWith(['Milk', 'Bread'])
    store.splitRow(0, 4, 4)
    expect(names(store)).toEqual(['Milk', '', 'Bread'])
  })

  it('drops a selection rather than duplicating it', async () => {
    const store = await openWith(['Oat milk'])
    store.splitRow(0, 3, 8)
    expect(names(store)).toEqual(['Oat', ''])
  })

  it('is one undo step', async () => {
    const store = await openWith(['Oat milk'])
    store.splitRow(0, 3, 3)
    store.undo()
    expect(names(store)).toEqual(['Oat milk'])
  })

  it('leaves the new row without the quantity or tick of the one it came from', async () => {
    const store = await openWith(['Oat milk'])
    store.setQuantity(0, '2')
    store.toggleChecked(0, true)
    store.splitRow(0, 3, 3)
    expect(store.items[1]).toMatchObject({ name: ' milk', quantity: '', checked: false })
  })
})

// The inverse, from Backspace at the start of a name. `ShoppingListRow` only emits from
// that one caret position, so these all start there.
describe('joining a row into the one above', () => {
  it('appends the text to the row above and reports the seam', async () => {
    const store = await openWith(['Oat', ' milk', 'Bread'])
    expect(store.mergeRowUp(1)).toMatchObject({ caret: 3 })
    expect(names(store)).toEqual(['Oat milk', 'Bread'])
  })

  it('undoes a split exactly', async () => {
    const store = await openWith(['Oat milk'])
    const key = store.splitRow(0, 3, 3)
    expect(store.items[1]._key).toBe(key)
    store.mergeRowUp(1)
    expect(names(store)).toEqual(['Oat milk'])
  })

  it('does nothing on the first row, which has nothing above it', async () => {
    const store = await openWith(['Milk', 'Bread'])
    expect(store.mergeRowUp(0)).toBeNull()
    expect(names(store)).toEqual(['Milk', 'Bread'])
  })

  it('joins an empty row into the one above, leaving the caret at the end', async () => {
    const store = await openWith(['Milk', ''])
    expect(store.mergeRowUp(1)).toMatchObject({ caret: 4 })
    expect(names(store)).toEqual(['Milk'])
  })

  it('keeps the quantity and tick of the row above, and drops the absorbed row’s', async () => {
    const store = await openWith(['Oat', ' milk'])
    store.setQuantity(0, '2')
    store.toggleChecked(0, true)
    store.setQuantity(1, '9')
    store.mergeRowUp(1)
    expect(store.items).toHaveLength(1)
    expect(store.items[0]).toMatchObject({ name: 'Oat milk', quantity: '2', checked: true })
  })

  it('is one undo step', async () => {
    const store = await openWith(['Oat', ' milk'])
    store.mergeRowUp(1)
    store.undo()
    expect(names(store)).toEqual(['Oat', ' milk'])
  })
})

// The total under the list. `null` is what the page reads as "this is not a list to add
// up", so every case that should show nothing asserts on that.
describe('totalling a list of numbers', () => {
  /** A list of numbers is one without a quantity column — that is half the rule. */
  async function openTally(names) {
    const store = await openWith(names)
    await store.toggleQuantity()
    return store
  }

  it('adds the rows up, signs included', async () => {
    const store = await openTally(['100', '-40', '7'])
    expect(store.numericTotal).toBe(67)
  })

  it('skips blank rows instead of refusing to total, wherever they sit', async () => {
    const store = await openTally(['', '10', '', '5', ''])
    expect(store.numericTotal).toBe(15)
  })

  it('totals a single number surrounded by blanks', async () => {
    const store = await openTally(['', '42', ''])
    expect(store.numericTotal).toBe(42)
  })

  it('skips a row that is only whitespace', async () => {
    const store = await openTally(['10', '   ', '5'])
    expect(store.numericTotal).toBe(15)
  })

  it('reads "_" as a digit separator and ignores it, as PHP does', async () => {
    const store = await openTally(['50_000', '-1_500', '20'])
    expect(store.numericTotal).toBe(48520)
  })

  it('takes a separator anywhere, so a half-typed "50_" still counts', async () => {
    const store = await openTally(['50_', '1_0_0'])
    expect(store.numericTotal).toBe(150)
  })

  it('stays quiet on a row that is only separators', async () => {
    const store = await openTally(['100', '__'])
    expect(store.numericTotal).toBeNull()
  })

  it('stays quiet on a list that is not all numbers', async () => {
    const store = await openTally(['10', 'Milk'])
    expect(store.numericTotal).toBeNull()
  })

  it('stays quiet on decimals, which are not whole numbers', async () => {
    const store = await openTally(['1.5', '2'])
    expect(store.numericTotal).toBeNull()
  })

  it('stays quiet on a list with nothing in it yet', async () => {
    const store = await openTally([''])
    expect(store.numericTotal).toBeNull()
  })

  it('stays quiet while there is a quantity column, numbers or not', async () => {
    const store = await openWith(['100', '-40'])
    expect(store.showQuantity).toBe(true)
    expect(store.numericTotal).toBeNull()
  })

  it('follows an edit', async () => {
    const store = await openTally(['10', '5'])
    expect(store.numericTotal).toBe(15)
    editRow(store, 1, '6')
    expect(store.numericTotal).toBe(16)
    editRow(store, 1, 'six')
    expect(store.numericTotal).toBeNull()
  })
})

describe('creating and deleting offline', () => {
  it('creates a usable list offline and pushes it, without changing its local id', async () => {
    const store = freshStore()
    await store.fetchLists()

    server.offline = true
    const created = await store.createList('Hardware')
    expect(typeof created.id).toBe('string') // a temp id, so the URL is stable
    expect(created.serverId).toBe(null)

    await store.open(created.id)
    editRow(store, 0, 'Screws')
    await store.flush()

    server.offline = false
    await store.sync()

    expect(created.id).toBe(store.visibleLists.at(-1).id) // URL still resolves
    expect(created.serverId).toEqual(expect.any(Number))
    const remote = server.lists.find((l) => l.id === created.serverId)
    expect(remote.name).toBe('Hardware')
    expect(remote.items.map((i) => i.name)).toEqual(['Screws'])
    expect(store.pendingCount).toBe(0)
  })

  it('deletes offline and the list is not resurrected by a refresh', async () => {
    const seeded = server.seed('Groceries')
    const store = freshStore()
    await store.fetchLists()

    server.offline = true
    await store.deleteList(seeded.id)
    expect(store.visibleLists).toHaveLength(0)

    server.offline = false
    // A refresh before the tombstone is sent must not bring it back, even though the server
    // still lists it.
    await store.fetchLists()
    expect(store.visibleLists).toHaveLength(0)

    await store.sync()
    expect(server.lists).toHaveLength(0)
    expect(store.pendingCount).toBe(0)
  })

  it('keeps a reorder made offline and sends it once connected', async () => {
    const a = server.seed('A')
    const b = server.seed('B')
    const store = freshStore()
    await store.fetchLists()

    server.offline = true
    await store.reorderLists([...store.visibleLists].reverse())
    expect(store.visibleLists.map((l) => l.name)).toEqual(['B', 'A'])
    expect(store.pendingCount).toBe(1)

    server.offline = false
    await store.sync()
    expect(server.lists.find((l) => l.id === b.id).position).toBe(0)
    expect(server.lists.find((l) => l.id === a.id).position).toBe(1)
    expect(store.pendingCount).toBe(0)
  })
})

describe('conflicts', () => {
  it('pushes an offline edit when nobody else has touched the list', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)

    server.offline = true
    editRow(store, 0, 'Oat milk')
    await store.flush()

    server.offline = false
    await store.sync()
    // The whole point of comparing against the version we synced from: our own edit must
    // not look like somebody else's.
    expect(notifications).toHaveLength(0)
    expect(server.lists[0].items.map((i) => i.name)).toEqual(['Oat milk'])
  })

  it('keeps the newer server copy and says so when both sides changed', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)

    server.offline = true
    editRow(store, 0, 'Oat milk')
    await store.flush()

    // Another device gets there first.
    server.offline = false
    server.editElsewhere(seeded.id, [{ name: 'Milk' }, { name: 'Bread' }])

    await store.sync()
    expect(store.items.map((i) => i.name)).toEqual(['Milk', 'Bread'])
    expect(server.lists[0].items.map((i) => i.name)).toEqual(['Milk', 'Bread'])
    expect(notifications).toHaveLength(1)
    expect(notifications[0].message).toContain('Groceries')
    expect(store.pendingCount).toBe(0)
  })

  it('does not let a refreshed index make cached items look current', async () => {
    // The subtle one. The index carries no items, so adopting its version for a list whose
    // items we hold would mark a stale item set as based on the newer version — and the
    // next push would then be accepted and silently overwrite the newer rows.
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)

    server.editElsewhere(seeded.id, [{ name: 'Milk' }, { name: 'Bread' }])
    await store.fetchLists()

    editRow(store, 0, 'Oat milk')
    await store.flush()
    await store.sync()

    // The other device's row must still be there, and the user must have been told.
    expect(server.lists[0].items.map((i) => i.name)).toEqual(['Milk', 'Bread'])
    expect(notifications).toHaveLength(1)
  })

  it('reorders without invalidating an edit that is waiting to be pushed', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    server.seed('Other')
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)

    server.offline = true
    editRow(store, 0, 'Oat milk')
    await store.flush()

    server.offline = false
    await store.reorderLists([...store.visibleLists].reverse())
    await store.sync()

    // A reorder is presentation, not content: it must not read as "somebody else wrote".
    expect(notifications).toHaveLength(0)
    expect(server.lists.find((l) => l.id === seeded.id).items.map((i) => i.name)).toEqual([
      'Oat milk',
    ])
  })
})

describe('logout', () => {
  it('leaves nothing behind for the next person on this browser', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const store = freshStore()
    await store.fetchLists()
    await store.open(seeded.id)
    await settle()
    expect(storage.size).toBe(1)

    store.clear()
    expect(store.lists).toHaveLength(0)
    expect(storage.size).toBe(0)
    await settle()
    // And the debounced write must not resurrect it after the fact.
    expect(storage.size).toBe(0)
  })
})
