/**
 * An in-memory stand-in for the shopping-list API, driving the real `src/api.js` through a
 * replaced `fetch` — so the tests exercise the actual request, error-body and
 * `isNetworkError` code rather than a mock of it.
 *
 * It mirrors the two backend behaviours the sync logic depends on, both of which are
 * pinned separately by `ShoppingListVersionTest` against the real controller:
 *   - any accepted write bumps `version`, including an item-only one
 *   - reordering does NOT touch it
 */
export function makeServer() {
  const server = {
    lists: [],
    offline: false,
    nextId: 1,
    requests: [],
    // The raw request bodies, exactly as they went over the wire. `requests` records only
    // method and path; asserting that a plaintext name never left the device needs the bytes.
    sent: [],
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

  const ok = (data, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => ({ data, message: '', errors: null }),
  })

  function handle(method, path, query, body) {
    const id = Number(query.get('list_id'))
    const list = server.lists.find((l) => l.id === id)

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
        server.lists = server.lists.filter((l) => l.id !== id)
        return ok(null)
      }
    }

    return ok(null, 404)
  }

  server.install = () => {
    globalThis.fetch = async (url, init = {}) => {
      if (server.offline) {
        // What a real transport failure looks like, which is what `isNetworkError` reads.
        throw new TypeError('Failed to fetch')
      }
      const parsed = new URL(url, 'http://test.local')
      const path = parsed.pathname.replace(/^\/api\//, '')
      const method = init.method ?? 'GET'
      server.requests.push(`${method} ${path}${parsed.search}`)
      if (init.body !== undefined) server.sent.push({ method, path, raw: String(init.body) })
      return handle(
        method,
        path,
        parsed.searchParams,
        init.body ? JSON.parse(init.body) : undefined,
      )
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
