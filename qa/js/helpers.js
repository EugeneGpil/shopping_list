// Injected with Page.addScriptToEvaluateOnNewDocument, so it survives a real reload.
//
// Two jobs: put the API token where `src/api.js` looks for it (Google OAuth cannot be passed
// in an automation browser, so the sanctum token is planted directly), and give the driver a
// small element-by-text toolkit so nothing is ever clicked by screen coordinates.
//
// `{{QA_TOKEN}}` is filled in by `cdp_client.mjs` from the environment — a token committed here
// would be dead by the next reseed.
;(() => {
  const TOKEN = '{{QA_TOKEN}}'
  try {
    localStorage.setItem('sanctum_token', TOKEN)
  } catch (e) {}

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const label = (el) => norm(el.innerText).slice(0, 60) || el.tagName.toLowerCase()
  const describe = (sel, text) => sel + (text ? ` / "${text}"` : '')
  const outline = (el) =>
    el ? `<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">` : 'nothing'

  // What a real user cannot click, cheapest test first: a box with no area, something CSS has
  // taken out of the flow, and a subtree the browser itself excludes from interaction — `inert`
  // or `aria-hidden`, which is how a dialog puts the page behind it out of reach.
  const reachable = (el) => {
    if (el.getClientRects().length === 0) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return !el.closest('[inert]') && !el.closest('[aria-hidden="true"]')
  }

  // The test an overlay cannot pass, and the reason the three above are not enough: with a modal
  // open its backdrop is laid out over the page, so a button behind it is still sized, still
  // visible and — Quasar marks neither — still not inert, it is simply not what a click at that
  // spot would reach. So ask the document what is at the centre of the box and require the answer
  // to be the element or something inside it. A backdrop answers with itself; that is what caught
  // a `click("button", "delete")` landing on a list row's delete button behind the passkey dialog.
  // Returns what is in the way, or null when the element is the thing that would be clicked.
  const covering = (el) => {
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    if (hit && (hit === el || el.contains(hit))) return null
    return hit ? outline(hit) : 'nothing — its centre is outside the viewport'
  }

  const qa = {
    TOKEN,
    // Every element the selector matches, unfiltered — for counting rows and reading state.
    // Clicking goes through `matches`/`click`, which drop what a user could not reach.
    all: (sel) => Array.from(document.querySelectorAll(sel)),
    // Reachable elements whose visible text contains `text`, with any that only contain
    // another match dropped: `*` matches every ancestor of the real control, and clicking one
    // of those is how a wrong guess used to read as a success.
    matches(sel, text) {
      const hits = qa.all(sel).filter((el) => reachable(el) && norm(el.innerText).includes(text))
      return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)))
    },
    byText(sel, text) {
      return qa.matches(sel, text)[0] ?? null
    },
    // Throws on a miss and on an ambiguous match, rather than clicking the wrong thing or
    // nothing at all: a silent no-op here is a scenario that passes without testing anything.
    click(sel, text) {
      const found = text ? qa.matches(sel, text) : qa.all(sel).filter(reachable)
      if (found.length === 0) throw new Error(`__qa.click: nothing matches ${describe(sel, text)}`)
      if (found.length > 1) {
        throw new Error(
          `__qa.click: ${found.length} elements match ${describe(sel, text)} — ` +
            `narrow the selector: ${found.map(label).join(' | ')}`,
        )
      }
      const el = found[0]
      el.scrollIntoView({ block: 'center' })
      const blocked = covering(el)
      if (blocked) {
        throw new Error(`__qa.click: ${describe(sel, text)} is covered by ${blocked}`)
      }
      el.click()
      return label(el)
    },
    fill(sel, value, index = 0) {
      const el = qa.all(sel)[index]
      if (!el) throw new Error('not found: ' + sel + ' #' + index)
      el.focus()
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return el.value
    },
    text: () => norm(document.body.innerText),
    // Anything that looks like a base64 blob on screen — the check for "no ciphertext leaked
    // into the UI". Item names in the fixtures are short words, so a 30+ char run is a blob.
    base64OnScreen: () => norm(document.body.innerText).match(/[A-Za-z0-9+/]{30,}={0,2}/g) || [],
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async wait(predicate, ms = 10000) {
      const start = Date.now()
      for (;;) {
        let v
        try {
          v = predicate()
        } catch (e) {
          v = null
        }
        if (v) return v
        if (Date.now() - start > ms) return null
        await qa.sleep(100)
      }
    },
    app: () => document.querySelector('#q-app')?.__vue_app__ ?? null,
    pinia: () => qa.app()?.config.globalProperties.$pinia ?? null,
    state: (id) => qa.pinia()?.state.value[id] ?? null,
    store: (id) => qa.pinia()?._s.get(id) ?? null,
    router: () => qa.app()?.config.globalProperties.$router ?? null,
    storage: () => {
      const out = {}
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        out[k] = localStorage.getItem(k)
      }
      return out
    },
  }

  window.__qa = qa
})()
