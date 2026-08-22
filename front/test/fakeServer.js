/**
 * An in-memory stand-in for the shopping-list API, driving the real `src/api.js` through a
 * replaced `fetch` — so the tests exercise the actual request, error-body and
 * `isNetworkError` code rather than a mock of it.
 *
 * It mirrors the backend behaviours the sync logic depends on, each of which is pinned
 * separately against the real controllers — the first two by `ShoppingListVersionTest`, the
 * last by `ShoppingListTrashTest`:
 *   - any accepted write bumps `version`, including an item-only one
 *   - reordering does not touch it
 *   - deleting a list only trashes it, and a trashed list is a 404 on every live endpoint
 */

// Imported rather than restated, so `purge_at` here is the same arithmetic on the same window
// the client renders its countdown from: a fake server that disagreed with the front end about
// how long the trash keeps a list would pass its own tests while the app was wrong. Still two
// copies of the number overall — `trashClock.js` and `config('trash.retention_days')` — because
// the server never tells the client the setting; see the `RETENTION_DAYS` docblock for why.
import { RETENTION_DAYS } from 'src/utils/trashClock'

/**
 * The one validation rule these tests turn on: `ShoppingListRequest::MAX_FIELD`, on the name and
 * on every item field, as `StoreShoppingListRequest` and `UpdateShoppingListRequest` apply it.
 *
 * Restated rather than imported, since it lives in PHP — and that is the point of having it here
 * at all: with no length rule this server accepts anything, so nothing on this side could notice
 * the client and the server disagreeing about how long a sealed field may be, which is the
 * disagreement that produced a 422 on text the user could see was short (§5, §9).
 *
 * Counted in codepoints, because Laravel's `max` on a string is `mb_strlen`: `[...text].length`
 * joins surrogate pairs, `text.length` would count an emoji twice.
 */
const MAX_FIELD = 10960

const tooLong = (value) => typeof value === 'string' && [...value].length > MAX_FIELD

export function makeServer() {
  const server = {
    lists: [],
    // Soft-deleted lists: still whole, invisible to every live endpoint. `DELETE shopping-list`
    // moves a list here rather than dropping it, exactly as the soft delete does — which is why
    // the tests that assert `server.lists` is empty after a delete still hold.
    trash: [],
    offline: false,
    nextId: 1,
    requests: [],
    // The raw request bodies, exactly as they went over the wire. `requests` records only
    // method and path; asserting that a plaintext name never left the device needs the bytes.
    sent: [],
    // Writes still allowed before the connection dies; null means no limit. See
    // `offlineAfterWrites`.
    writesLeft: null,
    // The one path that fails while everything else answers. See `offlineOn`.
    deadPath: null,
    // The status the next request is answered with instead of being handled. See `failOnce`.
    failStatus: null,
    // The requests being withheld before they are answered, and the promise that lets them go.
    // See `hold`.
    held: null,
    // And the ones already answered whose reply is being withheld. See `holdReply`.
    heldReply: null,
  }

  server.seed = (name, items = [], { encrypted = false } = {}) => {
    const list = {
      id: server.nextId++,
      name,
      position: server.lists.length,
      show_quantity: true,
      show_checkbox: true,
      // Opaque here, exactly as in the real controller: the flag is stored and echoed, and
      // nothing on this side ever looks at what the strings contain.
      encrypted,
      version: 0,
      items: items.map((i) => ({
        name: i.name ?? '',
        quantity: i.quantity ?? null,
        checked: !!i.checked,
      })),
    }
    server.lists.push(list)
    return list
  }

  const dropFromTrash = (id) => {
    server.trash = server.trash.filter((l) => l.id !== id)
  }

  const restoreFromTrash = (id) => {
    const list = server.trash.find((l) => l.id === id)
    dropFromTrash(id)
    delete list.deleted_at
    // Its `position` was never touched, so it lands back where the user remembers it.
    server.lists.push(list)

    return list
  }

  /**
   * The same two operations, performed by somebody else's device while this one was offline —
   * which is the only way a queued restore or purge can find its list already gone.
   */
  server.purgeElsewhere = dropFromTrash
  server.restoreElsewhere = restoreFromTrash

  /** Somebody else's device writing to the same list. */
  server.editElsewhere = (id, items) => {
    const list = server.lists.find((l) => l.id === id)
    list.items = items.map((i) => ({
      name: i.name,
      quantity: i.quantity ?? null,
      checked: !!i.checked,
    }))
    list.version += 1
    return list
  }

  const present = (list) => ({
    id: list.id,
    name: list.name,
    show_quantity: list.show_quantity,
    show_checkbox: list.show_checkbox,
    encrypted: list.encrypted,
    version: list.version,
    items: list.items,
  })

  const trashTimes = (list) => ({
    deleted_at: new Date(list.deleted_at).toISOString(),
    purge_at: new Date(list.deleted_at + RETENTION_DAYS * 86400000).toISOString(),
  })

  const trashEntry = (list) => ({
    id: list.id,
    name: list.name,
    encrypted: list.encrypted,
    items_count: list.items.length,
    ...trashTimes(list),
  })

  const ok = (data, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => ({ data, message: '', errors: null }),
  })

  // An unhandled failure, in the envelope Laravel writes for one: `message` alone, not the
  // three keys `ApiResponse` sends. Both shapes reach the client under `api/*`.
  const fail = (status) => ({
    ok: false,
    status,
    json: async () => ({ message: 'Server Error' }),
  })

  // What Laravel answers a field over `MAX_FIELD` with, in the envelope its validator writes.
  const unprocessable = (field) => ({
    ok: false,
    status: 422,
    json: async () => ({
      message: `The ${field} field must not be greater than ${MAX_FIELD} characters.`,
      errors: { [field]: [`The ${field} field must not be greater than ${MAX_FIELD} characters.`] },
    }),
  })

  const overLongField = (body) => {
    if (tooLong(body.name)) return 'name'
    for (const [index, item] of (body.items ?? []).entries()) {
      if (tooLong(item.name)) return `items.${index}.name`
      if (tooLong(item.quantity)) return `items.${index}.quantity`
    }

    return null
  }

  function handle(method, path, query, body) {
    const id = Number(query.get('list_id'))
    const list = server.lists.find((l) => l.id === id)

    // Before anything is written, as validation runs before a controller: the two write paths
    // that carry user content are the only ones with a field to measure.
    if (body && (path === 'shopping-lists' || path === 'shopping-list') && method !== 'GET') {
      const field = overLongField(body)
      if (field) return unprocessable(field)
    }

    if (path === 'shopping-lists' && method === 'GET') {
      return ok(
        [...server.lists]
          .sort((a, b) => a.position - b.position)
          .map((l) => ({
            id: l.id,
            name: l.name,
            position: l.position,
            created_at: 'c',
            version: l.version,
            encrypted: l.encrypted,
            items_count: l.items.length,
          })),
      )
    }

    if (path === 'shopping-lists' && method === 'POST') {
      return ok(present(server.seed(body.name, [], { encrypted: !!body.encrypted })), 201)
    }

    if (path === 'shopping-lists/order' && method === 'PUT') {
      // Position only — deliberately no version bump, as in the controller.
      body.ids.forEach((listId, position) => {
        const target = server.lists.find((l) => l.id === listId)
        if (target) target.position = position
      })
      return ok(null)
    }

    if (path === 'shopping-list') {
      if (!list) return ok(null, 404)

      if (method === 'GET') return ok(present(list))

      if (method === 'PUT') {
        const base = body.base_version ?? null
        if (base !== null && base !== list.version) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              data: present(list),
              message: 'This list was changed elsewhere.',
              errors: null,
            }),
          }
        }
        if (body.name !== undefined) list.name = body.name
        if (body.show_quantity !== undefined) list.show_quantity = body.show_quantity
        if (body.show_checkbox !== undefined) list.show_checkbox = body.show_checkbox
        // `sometimes` in the real request class: absent leaves the flag as it was, which is
        // what stops an older client relabelling an encrypted list as plaintext.
        if (body.encrypted !== undefined) list.encrypted = body.encrypted
        if (body.items !== undefined) {
          list.items = body.items.map((i) => ({
            name: i.name ?? '',
            quantity: i.quantity ?? null,
            checked: !!i.checked,
          }))
        }
        list.version += 1
        return ok(present(list))
      }

      if (method === 'DELETE') {
        // Trashed, not destroyed: the row keeps everything it had and stops being visible to
        // every live endpoint, which is what the soft delete does on the real server.
        list.deleted_at = Date.now()
        server.lists = server.lists.filter((l) => l.id !== id)
        server.trash.push(list)
        return ok(null)
      }
    }

    // The three trash endpoints that name a list all answer 404 when it is not in the trash —
    // a live list included, as `onlyTrashed` does in the controller. The index takes no
    // `list_id` and always answers.
    if (path === 'trash' || path === 'trash/list' || path === 'trash/restore') {
      const trashed = server.trash.find((l) => l.id === id)

      if (path === 'trash' && method === 'GET') {
        // Newest deletion first, `id` breaking ties, as the controller orders it.
        return ok(
          [...server.trash]
            .sort((a, b) => b.deleted_at - a.deleted_at || b.id - a.id)
            .map(trashEntry),
        )
      }

      if (!trashed) return ok(null, 404)

      if (path === 'trash/list' && method === 'GET') {
        return ok({ ...present(trashed), ...trashTimes(trashed) })
      }

      if (path === 'trash/restore' && method === 'POST') {
        return ok(present(restoreFromTrash(id)))
      }

      if (path === 'trash' && method === 'DELETE') {
        dropFromTrash(id)
        return ok(null)
      }
    }

    return ok(null, 404)
  }

  /**
   * Go offline after `n` more writes — a tunnel arriving partway through a multi-list job.
   *
   * Counted in writes rather than requests so a test can say "die after the second list" without
   * having to know how many reads the pass makes on the way.
   */
  server.offlineAfterWrites = (n) => {
    server.writesLeft = n
  }

  /**
   * Die on requests to one path and answer the rest — `null` to stop.
   *
   * For the reads that resolve an anomaly: `offlineAfterWrites` cannot reach a GET, and a
   * connection that survives the push and not the question about it is otherwise unreachable.
   */
  server.offlineOn = (path) => {
    server.deadPath = path
  }

  /**
   * Answer the next request — whatever it is — with `status`, then go back to normal.
   *
   * The one answer `handle` cannot produce: every status it knows how to send is part of the
   * protocol the client reconciles against, and a client has to distinguish those from a server
   * that simply broke. Armed once rather than per path, because the tests that need it arrange
   * for exactly one request to be in flight.
   */
  server.failOnce = (status) => {
    server.failStatus = status
  }

  /**
   * The machinery both kinds of withholding need: a matcher, and a promise the test resolves.
   *
   * Two slots rather than one, so a test can arm both at the same time — one request on its way
   * out and another's reply on its way back is exactly the shape of the races worth reproducing.
   */
  const withhold = (slot) => (matches) => {
    let open
    const held = { matches, gate: new Promise((resolve) => (open = resolve)) }
    server[slot] = held

    return () => {
      if (server[slot] === held) server[slot] = null
      open()
    }
  }

  /**
   * Take the requests `matches(method, path)` picks out and leave them unanswered until the
   * returned `release` is called — one request genuinely in flight while the test carries on.
   *
   * Nothing else here is asynchronous: `handle` reads and mutates on the way in, so a request a
   * test means to still be on the wire has already landed by its next line. That is what hides a
   * race between two stores rather than reproducing it.
   */
  server.hold = withhold('held')

  /**
   * Answer the matching request from the state it finds *now* and hand that answer over only when
   * the returned `release` is called.
   *
   * The difference from `hold` is the whole point, and it is the difference between the two halves
   * of a request. `hold` withholds the request, so its answer is computed on release and is
   * therefore current — a slow connection on the way out. This withholds the reply of a request
   * that has already landed, so the client reads an answer describing a world that has since moved
   * on: the index read whose answer predates a delete that has since committed, which is the one
   * ordering `_fetchIndex` cannot reconcile its way out of.
   */
  server.holdReply = withhold('heldReply')

  server.install = () => {
    globalThis.fetch = async (url, init = {}) => {
      if (server.offline) {
        // What a real transport failure looks like, which is what `isNetworkError` reads.
        throw new TypeError('Failed to fetch')
      }
      const parsed = new URL(url, 'http://test.local')
      const path = parsed.pathname.replace(/^\/api\//, '')
      const method = init.method ?? 'GET'

      if (server.deadPath === path) throw new TypeError('Failed to fetch')

      if (server.writesLeft !== null && method !== 'GET') {
        if (server.writesLeft === 0) {
          server.offline = true
          throw new TypeError('Failed to fetch')
        }
        server.writesLeft -= 1
      }
      server.requests.push(`${method} ${path}${parsed.search}`)
      if (init.body !== undefined) server.sent.push({ method, path, raw: String(init.body) })

      // After the recording, before the answer exists: the request has left, and `handle` will
      // compute its answer from whatever the state is on release.
      const held = server.held
      if (held?.matches(method, path)) await held.gate

      const failStatus = server.failStatus
      server.failStatus = null

      const response = failStatus
        ? fail(failStatus)
        : handle(method, path, parsed.searchParams, init.body ? JSON.parse(init.body) : undefined)

      // The other half: answered, and what waits is the delivery. See `holdReply`.
      const heldReply = server.heldReply
      if (heldReply?.matches(method, path)) await heldReply.gate

      return response
    }
  }

  return server
}

/** localStorage for a node environment: the store's whole persistence layer depends on it. */
export function installLocalStorage() {
  const data = new Map()
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
    get length() {
      return data.size
    },
  }
  return data
}
