import { EncryptionLockedError, isUnlocked, openField, sealField } from './encryption'

/**
 * The shape of a list record, and the two translations between it and the API.
 *
 * **This is also the encryption seam** (`docs/go_encrypted.md` §4). `recordFromApi` and
 * `trashedRecordFromApi` decrypt on the way in; `payloadOf` encrypts on the way out. Nothing
 * above this file ever sees ciphertext — search, the row editor, undo, `numericTotal` all work
 * on plaintext in memory exactly as before — and nothing below it ever sees plaintext.
 *
 * That is why those three are async while everything around them is not: WebCrypto has no
 * synchronous API, so the seam is where the `await`s land. `recordFromIndexEntry` is the one
 * that is neither, and says why itself: the index carries no ciphertext, so it needs no key.
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
 *   items_count   written from whatever a read or a write brings back, plus the rows an import
 *                 arrives with. A row added or deleted offline does not touch it, so until the
 *                 next sync it describes what the server holds rather than what is on screen
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
 * One item field as it arrives from the server, made readable.
 *
 * The list's own `encrypted` flag decides, not the presence of a key: encryption is per list
 * (§1), so a collection where one list is encrypted and the rest are not is the normal state
 * rather than a transitional one. An empty or absent value is passed through — there is
 * nothing to decrypt and no blob to fail on.
 */
const readField = (value, encrypted) =>
  encrypted && value ? openField(value) : Promise.resolve(value)

/**
 * A title left encrypted by the account-wide design that §1 replaced.
 *
 * That version sealed list names too, so any list locked before the change carries a
 * ciphertext title the new code would render as base64. This opens it when the key is here,
 * and reports that it did — the caller marks the record dirty, so the next save writes the
 * title back in the clear and the list is permanently healed.
 *
 * Not a heuristic: a failed unwrap is GCM's authentication tag saying "these bytes were not
 * written by this key", which is exactly what an ordinary plaintext title looks like. So the
 * `catch` means "it was never encrypted", and that is the common case.
 *
 * **Deletable** once no list predates the change — one pass through every locked list on a
 * device that holds the key is enough.
 */
async function healLegacyTitle(name, encrypted) {
  if (!encrypted || !name || !isUnlocked()) return { name, healed: false }
  try {
    return { name: await openField(name), healed: true }
  } catch {
    return { name, healed: false }
  }
}

/**
 * Every field a record has, with the value it takes when the case at hand knows nothing
 * about it. The constructors below, and `fromStorage`, pass only what their own case does know.
 *
 * Stated once because stating it three times did not hold: `localRecord` had lost
 * `encrypted` altogether, so a list created offline carried `undefined` where `payloadOf`,
 * `currentEncrypted` and `encryptedCount` all expect a boolean — harmless only because each
 * of them coerces. A case can still be wrong about a value here, but it can no longer be
 * missing one.
 */
function makeRecord(fields) {
  return {
    id: null,
    serverId: null,
    name: '',
    show_quantity: true,
    show_checkbox: true,
    items_count: 0,
    items: null,
    version: null,
    encrypted: false,
    dirty: false,
    pendingDelete: false,
    ...fields,
  }
}

/** A full record from `GET/POST/PUT shopping-list`, which always includes the items. */
export async function recordFromApi(data) {
  const encrypted = !!data.encrypted
  const items = data.items ?? []

  const [rows, title] = await Promise.all([
    Promise.all(
      items.map(async (i) =>
        createRow({
          name: (await readField(i.name, encrypted)) ?? '',
          quantity: (await readField(i.quantity, encrypted)) ?? '',
          checked: !!i.checked,
        }),
      ),
    ),
    healLegacyTitle(data.name, encrypted),
  ])

  return makeRecord({
    id: data.id,
    serverId: data.id,
    // Never encrypted, on purpose (§1): the index has to render every title without a key,
    // so the app opens and works with no prompt at all until an encrypted list is opened.
    // The cost is that the server learns the *title* of a private list, never its contents.
    name: title.name ?? '',
    show_quantity: data.show_quantity ?? true,
    show_checkbox: data.show_checkbox ?? true,
    items_count: items.length,
    items: rows,
    version: data.version ?? null,
    // What the server holds, and what the next write will do — `payloadOf` reads this. A list
    // is encrypted because it was marked so, not because this device happens to hold a key.
    encrypted,
    // Normally false: a record straight from the server has nothing pending. True only for a
    // legacy title just opened, which is a local change the server has not got yet.
    dirty: title.healed,
  })
}

/**
 * The same list read out of the trash: a record, plus the two dates only a trashed one has.
 *
 * A named constructor rather than a spread at the call site for the reason `makeRecord` exists
 * at all — an inline shape is one nothing states, and `TrashedListPage` reads `purge_at` from it
 * with no way to tell a field it can rely on from one that happened to be there.
 *
 * Deliberately a superset rather than a fourth interchangeable producer: these two fields make
 * it a different shape from every other record, which is safe only because a trashed record
 * never goes near the machinery that assumes they all match — it is not in the lists store,
 * `forStorage` never sees it, and nothing compares it to a live record.
 */
export async function trashedRecordFromApi(data) {
  return {
    ...(await recordFromApi(data)),
    deleted_at: data.deleted_at ?? null,
    purge_at: data.purge_at ?? null,
  }
}

/**
 * What the index endpoint gives us: everything except the items and the column settings.
 *
 * Never needs the key, and that is the point of the design: titles are plaintext, so the whole
 * index renders on a locked device exactly as it does on an unlocked one.
 */
export function recordFromIndexEntry(entry) {
  return makeRecord({
    id: entry.id,
    serverId: entry.id,
    name: entry.name ?? '',
    items_count: entry.items_count ?? 0,
    // Not "empty" — unread. The column settings the index says nothing about are left at
    // their defaults for the same reason, and both are replaced by the full read that
    // happens when the list is opened.
    items: null,
    version: entry.version ?? null,
    encrypted: !!entry.encrypted,
  })
}

/** A record for a list created while offline: real and editable, just not on the server. */
export function localRecord(name) {
  return makeRecord({
    id: nextTempId(),
    name,
    // Empty rather than unread: there is no server copy to read, so this list is complete
    // the moment it exists.
    items: [],
    // Dirty from birth: the list itself is the pending change.
    dirty: true,
  })
}

/**
 * The whole list as the API wants it. Everything local goes in one PUT — the endpoint
 * replaces the full item set anyway, so there is nothing to gain from partial writes and
 * a lot to gain from having exactly one write path.
 *
 * **The list decides, not the device.** `record.encrypted` is what this reads, so a device
 * holding a key writes an ordinary list in the clear and a private one as ciphertext, in the
 * same session and with no mode to be in. The flag rides along in the same request as the
 * content it describes, so the two can never disagree (§5) — which is also what makes
 * "encrypt this list" and "stop encrypting it" nothing more than flipping it and pushing.
 *
 * The flag is sent on every write rather than only when true: `sometimes` on the server means
 * an absent flag leaves the old value alone, so turning encryption *off* for a list has to be
 * stated explicitly or the row would stay marked encrypted with plaintext inside it.
 */
export async function payloadOf(record) {
  const rows = (record.items ?? []).map((r) => ({
    name: r.name.trim(),
    quantity: r.quantity?.trim() || null,
    checked: !!r.checked,
  }))

  const payload = {
    // Titles are never encrypted (§1) — see `recordFromApi`.
    name: record.name,
    show_quantity: !!record.show_quantity,
    show_checkbox: !!record.show_checkbox,
    encrypted: !!record.encrypted,
  }

  if (!record.encrypted) return { ...payload, items: rows }

  // An encrypted list cannot be written without the key. Reachable with no UI at fault: an
  // edit made offline is still `dirty` after a restart, and the first sync fires before any
  // fingerprint prompt. Sending it would put plaintext under a row still flagged encrypted —
  // unreadable on every other device, and left on the server until a vacuum (§8). Refusing
  // keeps the edit local until the key is back, which is what `pushList` does with this.
  if (!isUnlocked()) throw new EncryptionLockedError()

  return {
    ...payload,
    items: await Promise.all(
      rows.map(async (r) => ({
        name: await sealField(r.name),
        // A blank quantity stays null rather than becoming ciphertext of "". The column is
        // nullable, and encrypting nothing would only tell the server that the field exists.
        quantity: r.quantity === null ? null : await sealField(r.quantity),
        checked: r.checked,
      })),
    ),
  }
}

/** Strip what must not outlive the session before writing to storage. */
export function forStorage(records) {
  return records.map((r) => ({
    ...r,
    items: r.items?.map(({ name, quantity, checked }) => ({ name, quantity, checked })) ?? null,
  }))
}

/**
 * The inverse: rows come back as rows, with keys from this session's counter.
 *
 * Through `makeRecord` as well, so the cache is held to the same shape as the three
 * constructors. A record written by an older build is missing whatever fields that build did
 * not have — `encrypted` for anything created offline before the collapse — and without this
 * it would come back with that gap every launch, until the list reaches the server and a
 * full read fills it in.
 */
export function fromStorage(records) {
  return records.map((r) =>
    makeRecord({
      ...r,
      items: r.items?.map((i) => createRow(i)) ?? null,
    }),
  )
}
