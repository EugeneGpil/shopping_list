import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { installLocalStorage, makeServer } from './fakeServer'
import { notifications } from './stubs/quasar'
import { readFileSync } from 'node:fs'
import { generateDek } from 'src/utils/crypto'
import { RETENTION_DAYS } from 'src/utils/trashClock'
import { clearDek, sealField, setDek } from 'src/stores/shoppingLists/encryption'

/**
 * The trash, offline: cached on the device, with restores and delete-for-goods queued exactly
 * as list edits are.
 *
 * The same setup as `shoppingLists.spec.js` — the real `src/api.js` against the fake server, the
 * real localStorage mirror — because the claims here are about what survives a cold launch and
 * what goes out when a connection returns, and neither is visible through a mocked store.
 */

// The real auth store boots Firebase, which has no business in these tests. Only the two things
// the stores ask of it are needed.
vi.mock('src/stores/auth', () => ({
  useAuthStore: () => ({ user: { uid: 'user-1' }, retrySync: async () => {} }),
}))

const { useShoppingListsStore } = await import('src/stores/shoppingLists')
const { useTrashStore } = await import('src/stores/trash')

// Longer than PERSIST_DEBOUNCE (300ms) in the store, so its copy has landed on disk.
const settle = (ms = 380) => new Promise((r) => setTimeout(r, ms))

let server
let storage

/** Both stores with nothing carried over in memory, as after a cold launch. */
function freshStore() {
  setActivePinia(createPinia())

  return { lists: useShoppingListsStore(), trash: useTrashStore() }
}

const names = (trash) => trash.visibleEntries.map((e) => e.name)

beforeEach(() => {
  storage = installLocalStorage()
  server = makeServer()
  server.install()
  notifications.length = 0
})

afterEach(() => {
  // Otherwise the key leaks into the next test and the locked cases silently pass.
  clearDek()
})

/** Seed a list, delete it through the store, and hand back a loaded trash. */
async function deleteList(name, items = [], options = {}) {
  const seeded = server.seed(name, items, options)
  const store = freshStore()
  await store.lists.fetchLists()
  await store.lists.deleteList(seeded.id)
  await store.trash.fetch()

  return { ...store, seeded }
}

describe('what deleting a list does', () => {
  it('puts it in the trash rather than destroying it', async () => {
    const { trash, seeded } = await deleteList('Groceries', [{ name: 'Milk' }])

    expect(server.lists).toHaveLength(0)
    expect(names(trash)).toEqual(['Groceries'])
    const entry = trash.visibleEntries[0]
    expect(entry.id).toBe(seeded.id)
    expect(entry.items_count).toBe(1)
    // Both dates come from the server, which is what makes the countdown on screen and the
    // deletion the prune performs the same window.
    expect(new Date(entry.purge_at).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('the trash on a device with no connection', () => {
  it('renders the cached copy after a cold start, and says it is unconfirmed', async () => {
    await deleteList('Groceries', [{ name: 'Milk' }])
    await settle()
    expect([...storage.keys()]).toContain('trash:v1:user-1')

    server.offline = true
    const second = freshStore()
    // Before anything is fetched: hydration is what makes the first frame the cached trash
    // rather than a spinner.
    expect(names(second.trash)).toEqual(['Groceries'])
    expect(second.trash.loaded).toBe(true)

    await expect(second.trash.fetch()).rejects.toThrow()
    expect(second.trash.stale).toBe(true)
    expect(names(second.trash)).toEqual(['Groceries'])
  })

  it('keeps a queued action across a refresh that the server answers', async () => {
    const { trash, seeded } = await deleteList('Groceries')
    server.offline = true
    await trash.purge(seeded.id)

    server.offline = false
    // The server still lists it — the purge has not been sent — so without the reconcile the
    // refresh would put it back on screen and lose the decision.
    await trash.fetch()
    expect(names(trash)).toEqual([])
    expect(trash.pendingCount).toBe(1)
  })

  it('drops an entry the server no longer returns', async () => {
    const { trash, seeded } = await deleteList('Groceries')
    server.restoreElsewhere(seeded.id)

    await trash.fetch()
    expect(trash.entries).toEqual([])
  })

  it('lists a list this device deleted offline, once the reconnect lets the delete out', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const { lists, trash } = freshStore()
    await lists.fetchLists()

    server.offline = true
    await lists.deleteList(seeded.id)
    // Trashed here and nowhere else, so the server's trash does not have it — and the read
    // below would come back without it and leave the list in neither place.
    expect(lists.pendingCount).toBe(1)

    server.offline = false
    await trash.fetch()
    expect(names(trash)).toEqual(['Groceries'])
    expect(lists.pendingCount).toBe(0)
  })

  it('lists it even when the reconnect had already started the flush', async () => {
    const seeded = server.seed('Groceries', [{ name: 'Milk' }])
    const { lists, trash } = freshStore()
    await lists.fetchLists()

    server.offline = true
    await lists.deleteList(seeded.id)

    server.offline = false
    const release = server.hold((method) => method === 'DELETE')
    // What a reconnect does: `MainLayout.syncQueues()` starts the flush and does not await it.
    // So the tombstone is on the wire and unanswered at the moment the trash page loads, and
    // the read has to wait for *that* pass — a flag saying one is running is not enough.
    const flush = lists.sync()
    // Released from a timer rather than here, so the read below begins while the DELETE is
    // still out there. Releasing first would put the two requests back in order and prove
    // nothing.
    setTimeout(release, 0)

    await trash.fetch()
    expect(names(trash)).toEqual(['Groceries'])
    await flush
  })
})

describe('restoring offline', () => {
  it('leaves the screen at once, stays queued, and goes out on the next sync', async () => {
    const { lists, trash, seeded } = await deleteList('Groceries', [{ name: 'Milk' }])

    server.offline = true
    expect(await trash.restore(seeded.id)).toBe('offline')
    expect(names(trash)).toEqual([])
    expect(trash.pendingCount).toBe(1)
    // Not on the index either: nothing can put it there until the server has restored it.
    expect(lists.visibleLists).toHaveLength(0)

    server.offline = false
    await trash.sync()
    expect(trash.entries).toEqual([])
    expect(trash.pendingCount).toBe(0)
    // The list is back on the server, with its rows, and the index has been reloaded — which
    // is the only way the lists store can learn about a list it had already dropped.
    expect(server.lists.map((l) => l.name)).toEqual(['Groceries'])
    expect(lists.visibleLists.map((l) => l.name)).toEqual(['Groceries'])
    expect(server.trash).toHaveLength(0)
  })

  it('survives a restart with the queue intact', async () => {
    const { trash, seeded } = await deleteList('Groceries')
    server.offline = true
    await trash.restore(seeded.id)
    await settle()

    // Killed with the restore still queued: the flag is the queue, so it has to be on disk.
    const second = freshStore()
    expect(second.trash.pendingCount).toBe(1)
    server.offline = false
    await second.trash.sync()
    expect(server.lists.map((l) => l.name)).toEqual(['Groceries'])
  })

  it('warns and gives up when the list was deleted for good elsewhere', async () => {
    const { trash, seeded } = await deleteList('Groceries')

    server.offline = true
    await trash.restore(seeded.id)
    // Somebody else emptied the trash while this device was in a tunnel. Asking for a list
    // back and not getting it is the one outcome here worth interrupting for.
    server.offline = false
    server.purgeElsewhere(seeded.id)

    await trash.sync()
    expect(trash.entries).toEqual([])
    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('warning')
    expect(notifications[0].message).toContain('Groceries')
  })

  it('says nothing when the list had already been put back elsewhere', async () => {
    const { lists, trash, seeded } = await deleteList('Groceries', [{ name: 'Milk' }])

    server.offline = true
    await trash.restore(seeded.id)
    // The same 404 as the test above, from the opposite cause: somebody else put this list back
    // while this device was in a tunnel. What was asked for is already true, so a warning about
    // a deletion would be an invention.
    server.offline = false
    server.restoreElsewhere(seeded.id)

    await trash.sync()
    expect(trash.entries).toEqual([])
    expect(notifications).toEqual([])
    expect(lists.visibleLists.map((l) => l.name)).toEqual(['Groceries'])
  })

  it('reports a list that is already back as done, not as a failure', async () => {
    const { trash, seeded } = await deleteList('Groceries')
    server.restoreElsewhere(seeded.id)

    expect(await trash.restore(seeded.id)).toBe('saved')
  })
})

describe('deleting for good offline', () => {
  it('leaves the screen at once, stays queued, and goes out on the next sync', async () => {
    const { trash, seeded } = await deleteList('Groceries')

    server.offline = true
    expect(await trash.purge(seeded.id)).toBe('offline')
    expect(names(trash)).toEqual([])
    expect(trash.pendingCount).toBe(1)
    expect(server.trash).toHaveLength(1)

    server.offline = false
    await trash.sync()
    expect(trash.entries).toEqual([])
    expect(server.trash).toHaveLength(0)
    expect(server.lists).toHaveLength(0)
  })

  it('says nothing when the list was already gone — that is the outcome that was wanted', async () => {
    const { trash, seeded } = await deleteList('Groceries')

    server.offline = true
    await trash.purge(seeded.id)
    server.offline = false
    server.purgeElsewhere(seeded.id)

    await trash.sync()
    expect(trash.entries).toEqual([])
    expect(notifications).toEqual([])
  })

  it('says the deletion did not happen when the list was put back elsewhere', async () => {
    const { lists, trash, seeded } = await deleteList('Groceries', [{ name: 'Milk' }])

    server.offline = true
    await trash.purge(seeded.id)
    // The same 404 the test above treats as success, from the opposite cause. Silence here would
    // read as "deleted for good", and the list is alive.
    server.offline = false
    server.restoreElsewhere(seeded.id)

    await trash.sync()
    expect(trash.entries).toEqual([])
    expect(server.lists.map((l) => l.name)).toEqual(['Groceries'])
    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('warning')
    expect(notifications[0].message).toContain('Groceries')
    // Told about, and then actually on screen: the index has not been read since that restore.
    expect(lists.visibleLists.map((l) => l.name)).toEqual(['Groceries'])
  })

  it('reports a tap that lands after a restore elsewhere as not deleted', async () => {
    const { trash, seeded } = await deleteList('Groceries')
    server.restoreElsewhere(seeded.id)

    expect(await trash.purge(seeded.id)).toBe('restored')
  })

  it('keeps the decision queued when the read that would resolve a 404 cannot get through', async () => {
    const { trash, seeded } = await deleteList('Groceries')

    server.offline = true
    await trash.purge(seeded.id)
    server.offline = false
    server.restoreElsewhere(seeded.id)
    // The purge reaches the server and 404s; the read that says which of the two 404s it is
    // does not. Nothing is known, so nothing is claimed and nothing is thrown away.
    server.offlineOn('shopping-list')

    await trash.sync()
    expect(trash.pendingCount).toBe(1)
    expect(notifications).toEqual([])

    server.offlineOn(null)
    await trash.sync()
    expect(trash.pendingCount).toBe(0)
    expect(notifications).toHaveLength(1)
  })
})

describe('tapping an action twice', () => {
  it('does not send a second restore for a list already on its way back', async () => {
    const { trash, seeded } = await deleteList('Groceries')

    const [first, second] = await Promise.all([trash.restore(seeded.id), trash.restore(seeded.id)])
    expect(first).toBe('saved')
    // The second request would 404 — the list left the trash a moment ago, by this device — and
    // that 404 is indistinguishable from the list having been destroyed elsewhere.
    expect(second).toBe('queued')
    expect(server.requests.filter((r) => r.startsWith('POST trash/restore'))).toHaveLength(1)
  })

  it('does not send a second delete-for-good for a list already on its way out', async () => {
    const { trash, seeded } = await deleteList('Groceries')

    const [first, second] = await Promise.all([trash.purge(seeded.id), trash.purge(seeded.id)])
    expect(first).toBe('saved')
    expect(second).toBe('queued')
    expect(server.requests.filter((r) => r.startsWith('DELETE trash?'))).toHaveLength(1)
  })
})

describe('looking inside a trashed list', () => {
  /** A locked list, deleted: ciphertext rows on the server and an entry in the trash. */
  async function deleteLocked() {
    setDek(await generateDek())
    const items = [{ name: await sealField('водка'), quantity: await sealField('2') }]

    return deleteList('Секретный список', items, { encrypted: true })
  }

  it('decrypts an encrypted one, and opens it again offline from the cached copy', async () => {
    const { trash, seeded } = await deleteLocked()

    const record = await trash.view(seeded.id)
    expect(record.items.map((i) => i.name)).toEqual(['водка'])
    expect(record.encrypted).toBe(true)
    expect(record.purge_at).toBeTruthy()

    // A trashed list cannot be written to, so the copy on the device is not a stale copy of
    // anything — it is the list.
    server.offline = true
    const again = await trash.view(seeded.id)
    expect(again.items.map((i) => i.name)).toEqual(['водка'])
  })

  it('keeps the cached copy of a locked list sealed on disk', async () => {
    const { trash, seeded } = await deleteLocked()
    await trash.view(seeded.id)
    await settle()

    // The payload is cached raw, before the seam, so inspecting a private list once does not
    // leave its contents readable in localStorage.
    expect(storage.get('trash:v1:user-1')).not.toContain('водка')
  })

  it('can be restored when it was opened by URL, with the trash never listed', async () => {
    const { seeded } = await deleteList('Groceries', [{ name: 'Milk' }])

    // Straight to `/trash/list/:id` on a device that has never listed the trash: the read is
    // the only thing that knows this list is trashed, so it is what has to leave an entry
    // behind — otherwise the restore below would find nothing and report success anyway.
    const cold = freshStore()
    expect(cold.trash.entries).toEqual([])
    await cold.trash.view(seeded.id)
    expect(await cold.trash.restore(seeded.id)).toBe('saved')
    expect(server.lists.map((l) => l.name)).toEqual(['Groceries'])
  })

  it('reports a list it cannot reach and has never opened', async () => {
    const { trash, seeded } = await deleteList('Groceries')
    server.offline = true
    await expect(trash.view(seeded.id)).rejects.toThrow()
  })

  it('forgets the cached copy once the list leaves the trash', async () => {
    const { trash, seeded } = await deleteList('Groceries', [{ name: 'Milk' }])
    await trash.view(seeded.id)
    expect(trash.payloads[seeded.id]).toBeTruthy()

    await trash.restore(seeded.id)
    expect(trash.payloads[seeded.id]).toBeUndefined()
  })
})

describe('the last way into a locked list', () => {
  it('counts a trashed list, which can still be restored', async () => {
    const { trash } = await deleteList('Секретный список', [], { encrypted: true })

    // What `isLastWayIn` is built on: the list is gone from the index but its rows are still
    // ciphertext, so removing the only passkey would hand back something unopenable. The
    // server counts them the same way, and this is what keeps the button from promising
    // otherwise.
    expect(trash.encryptedCount).toBe(1)

    // On its way out, so it no longer holds the key hostage — unlike one on its way back.
    server.offline = true
    await trash.purge(trash.visibleEntries[0].id)
    expect(trash.encryptedCount).toBe(0)
  })
})

describe('logging out', () => {
  it('leaves nothing of this account in localStorage', async () => {
    const { trash, seeded } = await deleteList('Groceries', [{ name: 'Milk' }])
    await trash.view(seeded.id)
    await settle()
    expect([...storage.keys()]).toContain('trash:v1:user-1')

    trash.clear()
    await settle()
    expect([...storage.keys()]).not.toContain('trash:v1:user-1')
    expect(trash.entries).toEqual([])
    expect(trash.payloads).toEqual({})
  })
})

/**
 * The window is stated in four places and only two of them are code: `config('trash.retention_days')`
 * on the server, `RETENTION_DAYS` here, the confirmation dialog that quotes it — and the privacy
 * policy, which is published legal copy promising when data is deleted.
 *
 * That last one is the one worth a test. The other three are wording a user reads in passing; the
 * policy is the document the app is held to, it sits at the URL registered with Play, and nothing
 * else in the repo would notice it going stale. Shortening the window without touching it would
 * leave a published false statement about deletion standing, which is why this fails loudly rather
 * than leaving it to whoever remembers.
 *
 * It does not reach the server's config — a vitest cannot — so `RETENTION_DAYS` is the proxy, and
 * its own docblock is what ties that to the setting.
 */
describe('the retention window the policy promises', () => {
  it('is the window the app counts down', () => {
    // Whitespace collapsed first, because the claims below wrap across lines in the source and a
    // test that breaks on a re-wrap would be retired rather than fixed.
    const policy = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    )

    // Both halves of the promise, and each one names the number. Not a bare `${N} days` search:
    // the policy also promises that a maintenance copy goes within 30 days, so at a window of 30
    // that would match the wrong sentence and pass while the trash claim was stale — which is
    // exactly what it did on the first attempt.
    expect(policy).toContain(`kept for ${RETENTION_DAYS} days`)
    expect(policy).toContain(`at the end of those ${RETENTION_DAYS} days`)
    // The wording this replaced, which said a deleted list left the database at once. True until
    // deleting started trashing, and the kind of sentence that survives a feature by being
    // nobody's job.
    expect(policy).not.toContain('deletes its items from the database immediately')
  })
})
