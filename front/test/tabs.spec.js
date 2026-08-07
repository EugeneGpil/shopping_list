import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { installLocalStorage, makeServer } from './fakeServer'
import { notifications } from './stubs/quasar'

/**
 * Two tabs of the same app, sharing one localStorage key.
 *
 * Each tab holds the whole collection in memory and mirrors it wholesale, so left alone
 * they overwrite each other: an idle tab flushes its stale copy over the other's edit. The
 * `storage` event is what tells a tab it has gone stale; `refreshFromStorage()` — called by
 * that listener, and directly here — is what it does about it.
 *
 * Two real store instances against one localStorage is the honest simulation: both write
 * through their own debounce, exactly as two tabs would.
 */

vi.mock('src/stores/auth', () => ({
  useAuthStore: () => ({ user: { uid: 'user-1' }, retrySync: async () => {} }),
}))

const { useShoppingListsStore } = await import('src/stores/shoppingLists')

// Longer than PERSIST_DEBOUNCE (300ms) in the store, so a tab's write has landed on disk.
const settle = (ms = 380) => new Promise((r) => setTimeout(r, ms))

let server

/** A second tab: same localStorage, its own store instance and its own pinia. */
function openTab() {
  setActivePinia(createPinia())
  return useShoppingListsStore()
}

const names = (store) => store.visibleLists.map((l) => l.name)

beforeEach(() => {
  installLocalStorage()
  server = makeServer()
  server.install()
  notifications.length = 0
})

describe('a tab that has gone stale', () => {
  it('picks up a list another tab created', async () => {
    server.seed('Groceries')
    const tabA = openTab()
    await tabA.fetchLists()

    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.createList('Hardware')
    await settle()

    tabA.refreshFromStorage()
    expect(names(tabA)).toEqual(['Groceries', 'Hardware'])
  })

  it('picks up an edit another tab made', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const tabA = openTab()
    await tabA.fetchLists()
    await tabA.open(seeded.id)

    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.open(seeded.id)
    tabB.beginEdit()
    tabB.setName(0, 'Oat milk')
    tabB.endEdit()
    await tabB.flush()
    await settle()

    // Nothing of tabA's own is at stake here — it has not touched the list since opening.
    tabA.refreshFromStorage()
    expect(tabA.items.map((i) => i.name)).toEqual(['Oat milk'])
  })

  it('drops a list another tab deleted', async () => {
    const seeded = server.seed('Groceries')
    server.seed('Hardware')
    const tabA = openTab()
    await tabA.fetchLists()

    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.deleteList(seeded.id)
    await settle()

    tabA.refreshFromStorage()
    expect(names(tabA)).toEqual(['Hardware'])
  })

  it('takes the order another tab settled on', async () => {
    const first = server.seed('One')
    server.seed('Two')
    const tabA = openTab()
    await tabA.fetchLists()

    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.reorderLists([...tabB.visibleLists].reverse())
    await settle()

    tabA.refreshFromStorage()
    expect(names(tabA)).toEqual(['Two', 'One'])
    expect(tabA.visibleLists[1].id).toBe(first.id)
  })
})

describe('what a tab will not give up', () => {
  it('keeps its own unsent edit rather than taking the other tab’s copy', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const tabA = openTab()
    await tabA.fetchLists()
    await tabA.open(seeded.id)

    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.open(seeded.id)

    // Both tabs edit the same list with no connection, so neither has been settled by the
    // server. Ours is the one we can still lose, so ours stays.
    server.offline = true
    tabA.beginEdit()
    tabA.setName(0, 'Oat milk')
    tabA.endEdit()
    await tabA.flush()

    tabB.beginEdit()
    tabB.setName(0, 'Almond milk')
    tabB.endEdit()
    await tabB.flush()
    await settle()

    tabA.refreshFromStorage()
    expect(tabA.items.map((i) => i.name)).toEqual(['Oat milk'])
  })

  it('keeps a list of its own that never reached the other tab', async () => {
    server.seed('Groceries')
    const tabA = openTab()
    await tabA.fetchLists()
    server.offline = true
    await tabA.createList('Hardware') // local only, and not written yet

    server.offline = false
    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.createList('Garden')
    await settle()

    tabA.refreshFromStorage()
    expect(names(tabA)).toEqual(expect.arrayContaining(['Hardware', 'Garden']))
  })

  it('does not swap the rows of a list being typed into', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const tabA = openTab()
    await tabA.fetchLists()
    await tabA.open(seeded.id)
    // Focused, nothing typed yet: no edit to lose, but a caret to lose.
    tabA.beginEdit()
    const rowKey = tabA.items[0]._key

    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.open(seeded.id)
    tabB.beginEdit()
    tabB.setName(0, 'Oat milk')
    tabB.endEdit()
    await tabB.flush()
    await settle()

    tabA.refreshFromStorage()
    expect(tabA.items[0]._key).toBe(rowKey)
    expect(tabA.items.map((i) => i.name)).toEqual(['Milk'])
  })
})

describe('convergence', () => {
  it('settles rather than writing back and forth, since a merge that changes nothing arms nothing', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const tabA = openTab()
    await tabA.fetchLists()
    await tabA.open(seeded.id)

    const tabB = openTab()
    await tabB.fetchLists()
    await tabB.open(seeded.id)
    tabB.beginEdit()
    tabB.setName(0, 'Oat milk')
    tabB.endEdit()
    await tabB.flush()
    await settle()

    tabA.refreshFromStorage()
    const afterFirst = JSON.stringify(tabA.lists)
    // Whatever the other tab writes next is what this tab already holds, so the second
    // pass moves nothing — which is what stops the two of them ping-ponging.
    tabA.refreshFromStorage()
    expect(JSON.stringify(tabA.lists)).toBe(afterFirst)
  })
})
