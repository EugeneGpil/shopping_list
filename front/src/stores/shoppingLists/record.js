import { isUnlocked, openField, sealField } from './encryption'

/**
 * The shape of a list record, and the two translations between it and the API.
 *
 * **This is also the encryption seam** (`docs/go_encrypted.md` §4). `recordFromApi` and
 * `recordFromIndexEntry` decrypt on the way in; `payloadOf` encrypts on the way out. Nothing
 * above this file ever sees ciphertext — search, the row editor, undo, `numericTotal` all work
 * on plaintext in memory exactly as before — and nothing below it ever sees plaintext.
 *
 * That is why these three functions are async while everything around them is not: WebCrypto
 * has no synchronous API, so the seam is where the `await`s land.
 *
 * A record is what the app renders and what gets written to localStorage, so it carries
 * the sync bookkeeping alongside the data:
 *
 *   id            local identity, used in URLs and lookups — a server id, or `tmp-N`
 *                 for a list created offline
 *   serverId      the id the API knows, or null until the list has been created there
 *   version       the server's version counter at our last successful read or write.
 *                 Sent back as `base_version` on the next write; never touched locally, or
 *                 it would stop being a description of what the server holds
 *   dirty         local content the server has not accepted yet
 *   pendingDelete deleted here, tombstoned until the server agrees
 *   items         null until fetched, which is not the same as an empty list
 *
 * `id` stays put for the life of a record, including when a temp list is finally created
 * on the server — it only gains a `serverId`. That is what lets a user sit on
 * `/list/tmp-3` while it syncs without the URL being swapped underneath them.
 */

// Row keys only have to be unique within the session, and are deliberately never reset:
// a stale key from a list that is no longer open can then never collide with a new row in
// a page's ref map. Rehydrated rows get fresh keys for the same reason.
let keySeq = 0

export function createRow(fields = {}) {
  return { name: '', quantity: '', checked: false, ...fields, _key: ++keySeq }
}

let tempSeq = 0

export const isTemp = (id) => typeof id === 'string'
export const nextTempId = () => `tmp-${++tempSeq}`

/** Resume the counter above anything rehydrated, so a new offline list cannot reuse an id. */
export function seedTempIds(records) {
  for (const r of records) {
    const n = isTemp(r.id) ? Number(String(r.id).replace('tmp-', '')) : 0
    if (n > tempSeq) tempSeq = n
  }
}

/**
 * One field as it arrives from the server, made readable.
 *
 * The per-list `encrypted` flag decides, not the presence of a key: a mixed collection is
 * normal mid-enable (§5), so every list is judged on its own flag. An empty or absent value
 * is passed through — there is nothing to decrypt and no blob to fail on.
 */
const readField = (value, encrypted) =>
  encrypted && value ? openField(value) : Promise.resolve(value)

/** A full record from `GET/POST/PUT shopping-list`, which always includes the items. */
export async function recordFromApi(data) {
  const encrypted = !!data.encrypted
  const items = data.items ?? []

  const [name, rows] = await Promise.all([
    readField(data.name, encrypted),
    Promise.all(
      items.map(async (i) =>
        createRow({
          name: (await readField(i.name, encrypted)) ?? '',
          quantity: (await readField(i.quantity, encrypted)) ?? '',
          checked: !!i.checked,
        }),
      ),
    ),
  ])

  return {
    id: data.id,
    serverId: data.id,
    name,
    show_quantity: data.show_quantity ?? true,
    show_checkbox: data.show_checkbox ?? true,
    items_count: items.length,
    items: rows,
    version: data.version ?? null,
    // Carried so the record remembers what the server holds. `payloadOf` does not read it —
    // whether the *next* write is encrypted depends on whether this device has a key, not on
    // what the list used to be — but the index needs it to know how to read a name.
    encrypted,
    dirty: false,
    pendingDelete: false,
  }
}

/** What the index endpoint gives us: everything except the items. */
export async function recordFromIndexEntry(entry) {
  const encrypted = !!entry.encrypted

  return {
    id: entry.id,
    serverId: entry.id,
    name: await readField(entry.name, encrypted),
    show_quantity: true,
    show_checkbox: true,
    items_count: entry.items_count,
    // Not "empty" — unread. The column settings above are placeholders for the same
    // reason, and are replaced by the full read that happens when the list is opened.
    items: null,
    version: entry.version ?? null,
    encrypted,
    dirty: false,
    pendingDelete: false,
  }
}

/** A record for a list created while offline: real and editable, just not on the server. */
export function localRecord(name) {
  return {
    id: nextTempId(),
    serverId: null,
    name,
    show_quantity: true,
    show_checkbox: true,
    items_count: 0,
    items: [],
    version: null,
    // Dirty from birth: the list itself is the pending change.
    dirty: true,
    pendingDelete: false,
  }
}

/**
 * The whole list as the API wants it. Everything local goes in one PUT — the endpoint
 * replaces the full item set anyway, so there is nothing to gain from partial writes and
 * a lot to gain from having exactly one write path.
 *
 * Encrypts when this device holds a key, and says so with `encrypted: true` in the same
 * request as the ciphertext it describes — which is what makes an interrupted enable
 * resumable rather than ambiguous (§5).
 *
 * The decision is "do we have a key", not "was this list already encrypted". That is what
 * makes the enable pass in §6 nothing more than pushing every list: each one gets encrypted
 * and flagged on its way out, and a list created after setup is born encrypted.
 */
export async function payloadOf(record) {
  const rows = (record.items ?? []).map((r) => ({
    name: r.name.trim(),
    quantity: r.quantity?.trim() || null,
    checked: !!r.checked,
  }))

  if (!isUnlocked()) {
    return {
      name: record.name,
      show_quantity: !!record.show_quantity,
      show_checkbox: !!record.show_checkbox,
      items: rows,
    }
  }

  return {
    name: await sealField(record.name),
    show_quantity: !!record.show_quantity,
    show_checkbox: !!record.show_checkbox,
    items: await Promise.all(
      rows.map(async (r) => ({
        name: await sealField(r.name),
        // A blank quantity stays null rather than becoming ciphertext of "". The column is
        // nullable, and encrypting nothing would only tell the server that the field exists.
        quantity: r.quantity === null ? null : await sealField(r.quantity),
        checked: r.checked,
      })),
    ),
    encrypted: true,
  }
}

/** Strip what must not outlive the session before writing to storage. */
export function forStorage(records) {
  return records.map((r) => ({
    ...r,
    items: r.items?.map(({ name, quantity, checked }) => ({ name, quantity, checked })) ?? null,
  }))
}

/** The inverse: rows come back as rows, with keys from this session's counter. */
export function fromStorage(records) {
  return records.map((r) => ({
    ...r,
    items: r.items?.map((i) => createRow(i)) ?? null,
  }))
}
