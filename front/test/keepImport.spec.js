import { describe, it, expect, beforeEach, vi } from 'vitest'
import { deflateRawSync, crc32 } from 'node:zlib'
import { setActivePinia, createPinia } from 'pinia'
import { installLocalStorage } from './fakeServer'
import { candidatesFromZip, noteToCandidate } from 'src/utils/keepNotes'
import { readZipEntries } from 'src/utils/zipEntries'

// The real auth store boots Firebase, which has no business here — the lists store only
// wants a uid to key its local storage by.
vi.mock('src/stores/auth', () => ({
  useAuthStore: () => ({ user: { uid: 'user-1' }, retrySync: async () => {} }),
}))

const { useShoppingListsStore } = await import('src/stores/shoppingLists')

/**
 * Builds a real zip so the reader is tested against bytes rather than a stub — the parsing
 * is the part most likely to be subtly wrong, and a stub would prove nothing about it.
 */
function makeZip(files, { store = false } = {}) {
  const encoder = new TextEncoder()
  const locals = []
  const central = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const raw = encoder.encode(content)
    const body = store ? raw : new Uint8Array(deflateRawSync(raw))
    const nameBytes = encoder.encode(name)
    const crc = crc32(raw)

    const local = new Uint8Array(30 + nameBytes.length + body.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, store ? 0 : 8, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(body, 30 + nameBytes.length)
    locals.push(local)

    const entry = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(entry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, store ? 0 : 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    central.push(entry)

    offset += local.length
  }

  const centralSize = central.reduce((n, e) => n + e.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const parts = [...locals, ...central, end]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out.buffer
}

const checklist = (fields) =>
  JSON.stringify({ createdTimestampUsec: 1_700_000_000_000_000, ...fields })

describe('zip reading', () => {
  it('inflates only the entries asked for', async () => {
    const zip = makeZip({ 'Takeout/Keep/a.json': '{"a":1}', 'Takeout/Keep/a.html': '<p>a</p>' })

    const entries = await readZipEntries(zip, (n) => n.endsWith('.json'))

    expect(entries).toEqual([{ name: 'Takeout/Keep/a.json', text: '{"a":1}' }])
  })

  it('reads stored (uncompressed) entries too', async () => {
    const zip = makeZip({ 'Takeout/Keep/a.json': '{"a":1}' }, { store: true })

    expect(await readZipEntries(zip)).toEqual([{ name: 'Takeout/Keep/a.json', text: '{"a":1}' }])
  })

  it('round-trips non-ASCII content', async () => {
    const text = '{"t":"батарейки ไก่"}'
    const zip = makeZip({ 'Takeout/Keep/a.json': text })

    expect((await readZipEntries(zip))[0].text).toBe(text)
  })

  it('rejects something that is not a zip', async () => {
    const bytes = new TextEncoder().encode('this is a pdf, honest').buffer

    await expect(readZipEntries(bytes)).rejects.toThrow(/not a zip/i)
  })
})

describe('note conversion', () => {
  it('drops checked items and keeps the rest in order', () => {
    const candidate = noteToCandidate(
      {
        title: 'Groceries',
        listContent: [
          { text: 'milk', isChecked: false },
          { text: 'bread', isChecked: true },
          { text: '  eggs  ', isChecked: false },
          { text: '', isChecked: false },
        ],
      },
      'k',
    )

    expect(candidate.items).toEqual(['milk', 'eggs'])
    expect(candidate.droppedChecked).toBe(1)
  })

  it('skips a note whose items are all checked', () => {
    expect(noteToCandidate({ listContent: [{ text: 'soap', isChecked: true }] }, 'k')).toBeNull()
  })

  it('skips trashed notes', () => {
    const note = { isTrashed: true, listContent: [{ text: 'junk', isChecked: false }] }

    expect(noteToCandidate(note, 'k')).toBeNull()
  })

  it('skips archived notes', () => {
    const note = { isArchived: true, listContent: [{ text: 'lamp', isChecked: false }] }

    expect(noteToCandidate(note, 'k')).toBeNull()
  })

  it('names an untitled note after the day it was created', () => {
    const at = new Date(2025, 0, 3, 12).getTime() * 1000
    const note = { createdTimestampUsec: at, listContent: [{ text: 'x', isChecked: false }] }

    expect(noteToCandidate(note, 'k').title).toBe('Keep 2025-01-03')
  })

  // Keep stores a note as either a checklist or one block of text. The second has no items
  // of its own, so its lines become them — marked as a different kind, because that is a
  // guess and the dialog does not tick it by default.
  it('turns a plain text note into one item per line', () => {
    const candidate = noteToCandidate(
      { title: 'Notes', textContent: 'one\r\n  two  \n\n\nthree' },
      'k',
    )

    expect(candidate.kind).toBe('text')
    expect(candidate.items).toEqual(['one', 'two', 'three'])
    expect(candidate.droppedChecked).toBe(0)
  })

  it('marks a checklist as one', () => {
    expect(noteToCandidate({ listContent: [{ text: 'milk' }] }, 'k').kind).toBe('list')
  })

  it('skips a note with neither items nor text', () => {
    expect(noteToCandidate({ title: 'Empty' }, 'k')).toBeNull()
    expect(noteToCandidate({ title: 'Blank', textContent: ' \n\n ' }, 'k')).toBeNull()
  })
})

describe('candidates from an archive', () => {
  it('takes the Keep notes and ignores everything else in the export', async () => {
    const zip = makeZip({
      'Takeout/Keep/a.json': checklist({
        title: 'Groceries',
        listContent: [{ text: 'milk' }, { text: 'bread', isChecked: true }],
      }),
      'Takeout/Keep/a.html': '<p>ignored</p>',
      'Takeout/Keep/Labels.json': '[{"name":"Shopping"}]',
      'Takeout/Drive/unrelated.json': checklist({ listContent: [{ text: 'nope' }] }),
      'Takeout/Keep/archived.json': checklist({
        title: 'Put away',
        isArchived: true,
        listContent: [{ text: 'lamp' }],
      }),
    })

    const candidates = await candidatesFromZip(zip)

    expect(candidates).toHaveLength(1)
    expect(candidates[0].title).toBe('Groceries')
    expect(candidates[0].items).toEqual(['milk'])
  })

  // The dialog ticks the two kinds as groups, which only reads as a group if its rows sit
  // together.
  it('puts the checklists ahead of the plain text notes', async () => {
    const zip = makeZip({
      'Takeout/Keep/text-new.json': JSON.stringify({
        title: 'Text new',
        createdTimestampUsec: 4_000_000_000_000_000,
        textContent: 'a',
      }),
      'Takeout/Keep/list-old.json': JSON.stringify({
        title: 'List old',
        createdTimestampUsec: 1_000_000_000_000_000,
        listContent: [{ text: 'x' }],
      }),
      'Takeout/Keep/text-old.json': JSON.stringify({
        title: 'Text old',
        createdTimestampUsec: 2_000_000_000_000_000,
        textContent: 'b',
      }),
      'Takeout/Keep/list-new.json': JSON.stringify({
        title: 'List new',
        createdTimestampUsec: 3_000_000_000_000_000,
        listContent: [{ text: 'y' }],
      }),
    })

    expect((await candidatesFromZip(zip)).map((c) => c.title)).toEqual([
      'List new',
      'List old',
      'Text new',
      'Text old',
    ])
  })

  it('orders the newest note first', async () => {
    const zip = makeZip({
      'Takeout/Keep/old.json': JSON.stringify({
        title: 'Old',
        createdTimestampUsec: 1_000_000_000_000_000,
        listContent: [{ text: 'x' }],
      }),
      'Takeout/Keep/new.json': JSON.stringify({
        title: 'New',
        createdTimestampUsec: 2_000_000_000_000_000,
        listContent: [{ text: 'y' }],
      }),
    })

    expect((await candidatesFromZip(zip)).map((c) => c.title)).toEqual(['New', 'Old'])
  })

  it('refuses an archive with no Keep notes', async () => {
    const zip = makeZip({ 'Takeout/Drive/doc.json': '{}' })

    await expect(candidatesFromZip(zip)).rejects.toThrow(/no google keep notes/i)
  })
})

describe('importing into the store', () => {
  beforeEach(() => {
    installLocalStorage()
    setActivePinia(createPinia())
  })

  it('adds each list with its items, ready for the next sync', () => {
    const store = useShoppingListsStore()

    const records = store.importLists([
      { title: 'Groceries', items: ['milk', 'eggs'] },
      { title: 'Hardware', items: ['nails'] },
    ])

    expect(store.visibleLists).toHaveLength(2)
    expect(records[0].items.map((i) => i.name)).toEqual(['milk', 'eggs'])
    expect(records[0].items_count).toBe(2)
    // No server id and dirty is what `sync` looks for; without both the lists would sit
    // on the device forever.
    expect(records.every((r) => r.serverId === null && r.dirty)).toBe(true)
    // Keep carries no quantity, so the column would be empty on every row.
    expect(records[0].show_quantity).toBe(false)
  })

  it('counts the imported lists as waiting to sync', () => {
    const store = useShoppingListsStore()

    store.importLists([
      { title: 'A', items: ['x'] },
      { title: 'B', items: ['y'] },
    ])

    // Two lists plus the order, which the server has not been told about either.
    expect(store.pendingCount).toBe(3)
  })
})
