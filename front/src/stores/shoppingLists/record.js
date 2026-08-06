/**
 * The shape of a list record, and the two translations between it and the API.
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

/** A full record from `GET/POST/PUT shopping-list`, which always includes the items. */
export function recordFromApi(data) {
  return {
    id: data.id,
    serverId: data.id,
    name: data.name,
    show_quantity: data.show_quantity ?? true,
    show_checkbox: data.show_checkbox ?? true,
    items_count: (data.items ?? []).length,
    items: (data.items ?? []).map((i) =>
      createRow({ name: i.name, quantity: i.quantity ?? '', checked: !!i.checked }),
    ),
    version: data.version ?? null,
    dirty: false,
    pendingDelete: false,
  }
}

/** What the index endpoint gives us: everything except the items. */
export function recordFromIndexEntry(entry) {
  return {
    id: entry.id,
    serverId: entry.id,
    name: entry.name,
    show_quantity: true,
    show_checkbox: true,
    items_count: entry.items_count,
    // Not "empty" — unread. The column settings above are placeholders for the same
    // reason, and are replaced by the full read that happens when the list is opened.
    items: null,
    version: entry.version ?? null,
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
 */
export function payloadOf(record) {
  return {
    name: record.name,
    show_quantity: !!record.show_quantity,
    show_checkbox: !!record.show_checkbox,
    items: (record.items ?? []).map((r) => ({
      name: r.name.trim(),
      quantity: r.quantity?.trim() || null,
      checked: !!r.checked,
    })),
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
