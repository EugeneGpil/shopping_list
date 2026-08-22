// Models a device that has never seen these lists: the plaintext caches are removed before
// any app code runs (the store rewrites them ~300ms after boot, so doing this from an
// ordinary eval would be undone). Gated on sessionStorage so it can be armed and disarmed
// without removing the init script.
//
// The version segment is a pattern, not `v1`: the two constants this mirrors live in
// `front/src/stores/shoppingLists/storage.js` and `front/src/stores/trash.js` and both invite a
// bump, and a wipe that silently matches nothing runs the scenario on the warm cache it exists
// to remove — and passes. `shopping_lists:encryption:v1:<uid>` stays deliberately: that is the
// wrapped-key cache an offline unlock reads, and the pattern spares it because `encryption`
// is where a version segment would be.
if (sessionStorage.getItem('qa_wipe_lists') === '1') {
  for (const k of Object.keys(localStorage)) {
    if (/^(shopping_lists|trash):v\d+:/.test(k)) localStorage.removeItem(k)
  }
}
// The harder wipe, for a device that has seen nothing at all — everything but the planted
// token, which is the one thing a scenario cannot get back by itself.
if (sessionStorage.getItem('qa_wipe_all') === '1') {
  const token = localStorage.getItem('sanctum_token')
  localStorage.clear()
  if (token) localStorage.setItem('sanctum_token', token)
}
