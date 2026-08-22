# qa/ — driving the encrypted paths in a real browser

A small CDP harness that runs the app in a Chrome it launches itself, with a **virtual WebAuthn
authenticator** attached. It exists for one reason: the encryption feature's entry point is a
passkey, and nothing else in this repo can reach it. `crypto.spec.js` and `encryptedSeam.spec.js`
cover everything below the fingerprint by stubbing the PRF output; this covers the part above it —
the prompt, the unlock, the reload, the deep link, and what is actually on screen afterwards.

Four bugs came out of the first run of it, all in code the unit tests were green on, which is why
it is kept rather than thrown away.

## Prerequisites

- **Node ≥ 22**, and nothing else. The driver speaks CDP over `WebSocket`, a global since Node
  22.0 (marked stable in 22.4), so the harness installs nothing and adds nothing to any
  `package.json`. Every Node this project accepts already qualifies: `front/package.json`'s
  `engines` allows `^28 || ^26 || ^24 || ^22.12`, and the `node` container is `node:24`.
- **Run it on the host, not in the `node` container**: it launches Chrome, and the container has
  no browser in it. `QA_CHROME` overrides the binary (default `/opt/google/chrome/chrome`), which
  is packaged under a different path on every distro.
- `quasar dev -m pwa` up, and the API reachable at whatever `front/.env.local` points
  `VITE_API_URL` at.

## Why not the chrome-devtools MCP

The MCP launches Chrome with `--remote-debugging-pipe` and exposes no `WebAuthn` domain, so
`WebAuthn.addVirtualAuthenticator` cannot be called through it and `navigator.credentials.create()`
finds nothing to talk to. `cdp_driver.mjs` therefore launches its own Chrome on a TCP debugging
port and speaks CDP to it directly. This is the one thing in the project that is allowed to do
that — everything else, including any browsing that is not about passkeys, should still go through
the MCP.

## The constraints that are not obvious

Each of these cost an afternoon at least once.

- **One driver process for the whole scenario.** A virtual authenticator belongs to the CDP
  session: when the process exits, every credential in it is gone, and a wrapped DEK on the server
  whose authenticator no longer exists can never be unwrapped again. So the driver stays up and
  takes commands through a mailbox directory (`cdp_client.mjs`) instead of being re-run per step.
  A scenario that re-launches per step is not a slower scenario, it is a broken one.
- **The cache wipe has to be an init script.** `localStorage` holds the lists in plaintext by
  decision (`docs/go_encrypted.md` §7), and the store rewrites it about 300 ms after boot — so
  clearing it from an ordinary `eval` is undone before anything is looked at. `js/wipe_init.js`
  runs at document start, and is gated on `sessionStorage` so it can be armed and disarmed
  without removing the script.
- **`location.hash` is not a reload.** Changing the hash re-renders the SPA with the store, the
  session key and every cache still in memory, which is the opposite of the cold start most of
  these scenarios are about. Use the `reload` op, which is `Page.reload`.
- **Sign-in is faked, because it has to be.** Google will not complete OAuth in an automation
  browser and no one can do that step by hand for it. So `js/helpers.js` plants a sanctum token
  where `src/api.js` looks for it and `js/signin.js` writes the user into the auth store and pushes
  the router off `/login`. Both have to run again after every real reload — the init script comes
  back by itself, `signin.js` does not, and the app clears the planted token when it boots with no
  Firebase session, which is why `signin.js` re-plants it.
- **The fingerprint is the only simulated part.** The virtual authenticator is a real CTAP2
  implementation with `hasPrf`, so the PRF output is real and stable and everything the app
  derives from it is genuine. What it does not prove is a phone's secure element or Windows
  Hello — see §10 of `docs/go_encrypted.md`.
- **Nothing is clicked by coordinates.** `window.__qa` (from `js/helpers.js`) finds elements by
  selector and visible text, and verification reads the DOM rather than a screenshot.
- **Two failed unlocks look the same and take wildly different times.** With _no authenticator
  attached_ — `auth_remove` of the last one, the lost-device scenario — nothing ever answers the
  prompt and the app's own `TIMEOUT_MS` (`utils/passkey.js`, 60s) is what ends it: measured at
  60.0s before "No passkey was used…" appears. With a _fresh authenticator that holds no matching
  credential_ the platform refuses at once: 0.1s here. A poll of 10–30s reads the first one as a
  hang, so give the lost-device step at least 70 seconds (`eval <expr> 90`).

## Seeding

The harness signs in as one throwaway user and needs its firebase uid and a live sanctum token.
Neither is committed — `js/` carries `{{QA_TOKEN}}` and `{{QA_UID}}`, which `cdp_client.mjs` fills
from the environment and refuses to leave empty. A token pasted into a file
here would be dead by the next reseed and would fail as a blank screen rather than as an error.

Create the user and mint a token — it prints the token's id first, which is what revokes it later:

```bash
docker compose exec -T php php artisan tinker --execute='
$user = App\Models\User::firstOrCreate(
  ["firebase_uid" => "enc-qa"],
  ["name" => "Encryption QA", "email" => "enc-qa@example.test"]
);
$token = $user->createToken("qa");
echo $token->accessToken->id, " ", $token->plainTextToken, PHP_EOL;
'
```

**Revoke it when the run is over.** One per run accumulates: a token this account no longer needs
is a live credential for every list it owns.

```bash
docker compose exec -T php php artisan tinker --execute='
Laravel\Sanctum\PersonalAccessToken::find(72)->delete();   # the id printed above
'
```

### Resetting the fixtures — and it is the same command afterwards

Three plaintext lists, no key rows. This is both the seeding step and the restore step, so
**run it when finishing too**: a virtual authenticator dies with the driver process, so a list
left encrypted has a wrapped DEK nothing can ever open, and its item names are already ciphertext
on the server. Rebuilding from the fixture text is the only way back, which is why the fixtures
are three fixed lists rather than whatever the last scenario made.

```bash
docker compose exec -T php php artisan tinker --execute='
$user = App\Models\User::where("firebase_uid", "enc-qa")->firstOrFail();
$user->shoppingLists()->withTrashed()->get()->each(fn ($l) => $l->forceDelete());
App\Models\UserEncryption::where("user_id", $user->id)->delete();
$position = 0;
foreach ([
  "Plain groceries" => ["Milk", "Bread"],
  "To be locked" => ["qa fixture row 1", "qa fixture row 2"],
  "Diary" => ["diary entry one", "diary entry two"],
] as $name => $items) {
  $list = $user->shoppingLists()->create(["name" => $name, "position" => $position++, "encrypted" => false]);
  foreach (array_values($items) as $i => $item) {
    $list->items()->create(["name" => $item, "position" => $i]);
  }
  echo $list->id, " ", $name, PHP_EOL;
}
echo "keys=", App\Models\UserEncryption::where("user_id", $user->id)->count(), PHP_EOL;
'
```

The key rows live in **`user_encryption`** — singular, one row per credential
(`back/database/migrations/2026_08_09_000003_create_user_encryption_table.php`). The list ids it
prints are new every time by design: no scenario may depend on an id from anywhere but the run
that made it, so read them back from the app (`__qa.state('shoppingLists').lists`).

## Running

`quasar dev -m pwa` has to be up (`http://localhost:9200/` by default; `FRONT_URL` overrides).

```bash
export QA_TOKEN='72|...'          # from the seeding step above
export QA_UID=enc-qa              # optional, this is the default; export it for eval-file too
MB=/tmp/enc-qa-mailbox

qa/run.sh "$MB"                   # launches Chrome, injects, navigates, signs in
node qa/cdp_client.mjs "$MB" eval 'window.__qa.text()'
node qa/cdp_client.mjs "$MB" quit
```

`run.sh` prints the driver's `ready.json`, which includes the id of the first authenticator —
the one to remove when modelling a lost device.

**`node qa/cdp_client.mjs --help` prints every op with its arguments**; it is generated from the
table the client dispatches on, so it cannot fall behind. What each op _does_ is the comment at
the top of `cdp_driver.mjs`. `quit` answers `{"bye":true}` before Chrome is gone — give it a
couple of seconds, or `pgrep -f cdp_driver.mjs` will still show the process shutting down.

### Talking to the page

`eval` takes an **expression**, and the driver awaits whatever it evaluates to (`awaitPromise`).
So returning a promise is fine, but a top-level `await` is a syntax error — wrap anything
asynchronous in an async IIFE:

```bash
node qa/cdp_client.mjs "$MB" eval '(async () => { await __qa.sleep(500); return __qa.text() })()'
```

Two more things about it:

- **One shared global scope for the whole run.** A second `eval` that reuses a `const`/`let` name
  answers `{"page_error":"SyntaxError: Identifier 'b' has already been declared"}`. An IIFE avoids
  it; so does `var`.
- **The reply is `{"value":…}` or `{"page_error":"…"}`.** `page_error` is the page throwing, which
  a scenario may well be asserting. A bare `error` is the _driver_ failing — unknown op, unparsable
  command, a CDP call that threw — and never the page.
- **The default deadline is 60s**, matching the app's own WebAuthn timeout. `eval <expr> <seconds>`
  (and `eval-file <file> <seconds>`) widens it for the lost-device step.

### `window.__qa`

Defined by `js/helpers.js` as an init script, so it survives a real reload.

| call                                  | answers                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `TOKEN`                               | the planted sanctum token, for re-planting it after a reload                         |
| `all(sel)`                            | every match, unfiltered — for counting rows and reading state                        |
| `matches(sel, text)`                  | the matches a user could click whose visible text contains `text`, ancestors dropped |
| `byText(sel, text)`                   | the innermost of those, or `null` — the "is this on screen" check                    |
| `click(sel, text?)`                   | clicks it and returns its text; **throws** — see below                               |
| `fill(sel, value, index = 0)`         | sets the value and fires `input`/`change`; returns the value                         |
| `text()`                              | `document.body.innerText`, whitespace-collapsed                                      |
| `base64OnScreen()`                    | runs of 30+ base64 chars on screen — the "no ciphertext leaked into the UI" check    |
| `sleep(ms)`                           | a promise                                                                            |
| `wait(predicate, ms = 10000)`         | the first truthy value the predicate returns, or `null` on timeout                   |
| `app()`                               | the Vue app instance, or `null` before it mounts                                     |
| `pinia()` / `state(id)` / `store(id)` | the pinia instance, one store's raw state, one store instance (getters and actions)  |
| `router()`                            | vue-router, for `__qa.router().push('/list/194')`                                    |
| `storage()`                           | all of `localStorage` as an object                                                   |

`click` is deliberately loud: it throws when **nothing** matches, when **more than one** thing
matches (narrow the selector), and when the match is **covered** — zero-size, `display:none`,
`visibility:hidden`, inside `[inert]` or `[aria-hidden="true"]`, or not the element
`document.elementFromPoint` returns at its own centre. That last test is the one that matters:
with a dialog open, a button behind the backdrop is still sized, still visible and still not
inert, and `click("button", "delete")` used to reach the _list row's_ delete button behind an
open passkey dialog. It now answers
`__qa.click: … is covered by <div class="q-dialog__backdrop fixed-full">`.

## What a run leaves behind

- **The Chrome profile is deleted and recreated at every launch** (`--profile`, default
  `/tmp/enc-qa-chrome-profile`), so every `run.sh` is genuinely cold: `localStorage`, IndexedDB
  and cookies from the previous run are gone. `js/wipe_init.js` is for the reloads _within_ one
  run, where the store has already rewritten its cache.
- **What does survive `quit`** is the directory itself, holding the last run's data, plus the
  mailbox (`<MB>/ready.json`; `in/` and `out/` are cleared by the next driver) and `<MB>.log`.
  Nothing reads them, but they are yours to delete: `rm -rf /tmp/enc-qa-chrome-profile <MB> <MB>.log`.

## The pieces

| file              | what it is                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `cdp_driver.mjs`  | the long-running process: Chrome, the CDP session, the virtual authenticators, and the mailbox loop |
| `cdp_client.mjs`  | one command in, one JSON answer out; expands `{{PLACEHOLDER}}`s in loaded snippets                  |
| `run.sh`          | the four steps every scenario starts with                                                           |
| `js/helpers.js`   | init script: plants the token, defines `window.__qa`                                                |
| `js/wipe_init.js` | init script: drops the plaintext caches at document start                                           |
| `js/signin.js`    | fakes the signed-in user; re-run after every reload                                                 |

`qa/` is deliberately outside `front/`'s package scope — hence `.mjs`, so both files are
unambiguous standalone ESM scripts — and outside `npm run lint`'s glob, which only covers
`front/src*`, so nothing here is ever eslinted. Prettier does read it: `npx --prefix front
prettier --config front/.prettierrc.json --check 'qa/**/*.{mjs,js}'`.

## What `net` and `console` hand back

```json
{ "requests": [{ "method": "POST", "url": "…", "post_data": "{…}", "has_post_data": true, "status": 201, "error": null }] }
{ "messages": [{ "kind": "console.log", "text": "…" }, { "kind": "exception", "text": "…" }, { "kind": "log.error", "text": "…" }] }
```

Both drain: what has been read is gone from the driver, so a scenario can clear them before the
step it is about. `status` is an int or `null` and never anything else — a transport failure goes
in `error` (`"net::ERR_CONNECTION_REFUSED"`, with `status` left `null`), so `r.status >= 400` is
safe to write. `console` is one shape from three CDP producers: a console call
(`console.<type>` — `log`, `warning`, `debug`, `info`, whatever the page called, and a real drain
is mostly `console.debug` from vite), an uncaught exception (`exception`), and a browser log entry
(`log.<level>`). Match on the prefix, not on a list of kinds.

Every reply out of the mailbox is snake*case, including the `auth*\*`ones: CDP's`authenticatorId`and`credentialId`arrive as`authenticator_id`and`credential_id`, so nothing reads two dialects.

## A worked example: the bug that started this

Opening an encrypted list with the device's plaintext cache in place rendered the items with no
Unlock panel anywhere (`open()` served the cache and the refusal went nowhere).

```bash
# The list is on screen, readable, from cache.
node qa/cdp_client.mjs "$MB" eval "location.hash = '#/list/$LIST_ID'"
node qa/cdp_client.mjs "$MB" eval 'window.__qa.text()'

# Arm the wipe, then reload for real — which is where the hash would have lied.
node qa/cdp_client.mjs "$MB" eval "sessionStorage.setItem('qa_wipe_lists', '1')"
node qa/cdp_client.mjs "$MB" reload
node qa/cdp_client.mjs "$MB" eval-file qa/js/signin.js
node qa/cdp_client.mjs "$MB" eval "location.hash = '#/list/$LIST_ID'"
node qa/cdp_client.mjs "$MB" eval 'window.__qa.text()'
```

The two runs have to agree, and that is the whole assertion: "This list is encrypted", no rows,
and `window.__qa.base64OnScreen()` empty — with the cache in place and without it.
