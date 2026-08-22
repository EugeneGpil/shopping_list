// Fake the auth store: Google sign-in cannot be completed in an automation browser, so the
// user is planted in pinia and the router is nudged off /login. Run after every real reload.
;(async () => {
  const qa = window.__qa
  const app = await qa.wait(() => qa.app(), 15000)
  if (!app) return { ok: false, why: 'vue app never mounted' }
  const state = qa.state('auth')
  // The uid has to be the one the token belongs to: the store scopes its localStorage cache by
  // it, so a mismatch reads a cache that is not the token user's. The email is only displayed
  // and used as the passkey's user.name (the handle is the uid), so it is derived from the uid
  // rather than being a second thing to keep in step with the fixture.
  const uid = '{{QA_UID}}'
  state.user = { uid, email: `${uid}@example.test`, displayName: 'Encryption QA' }
  state.ready = true
  localStorage.setItem('sanctum_token', qa.TOKEN)
  qa.router().push('/')
  await qa.sleep(800)
  return {
    ok: true,
    hash: location.hash,
    uid: qa.state('auth').user.uid,
    lists: (qa.state('shoppingLists')?.lists ?? []).map(({ id, name, encrypted }) => ({
      id,
      name,
      encrypted,
    })),
    screen: qa.text().slice(0, 300),
  }
})()
