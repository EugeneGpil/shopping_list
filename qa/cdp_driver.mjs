#!/usr/bin/env node
/**
 * Headless Chrome + CDP WebAuthn driver for the encrypted-list paths.
 *
 * Why this exists: the chrome-devtools MCP launches Chrome with `--remote-debugging-pipe`
 * and exposes no `WebAuthn` domain, so the real passkey/PRF paths cannot be reached through
 * it. This launches its own Chrome on a TCP debugging port and adds a CTAP2 virtual
 * authenticator with `hasPrf`, which makes `navigator.credentials.create()/get()` return a
 * real, stable `prf.results.first` — the app's own crypto then runs unmodified.
 *
 * **One process for the whole scenario.** A virtual authenticator lives on the CDP session:
 * when this process exits, every credential in it is gone, and any wrapped DEK left on the
 * server is orphaned (no authenticator can unwrap it). So the driver stays up and takes
 * commands over a mailbox directory instead of being re-run per step.
 *
 * Zero dependencies on purpose: `WebSocket` is a global since Node 22.0 (marked stable in
 * 22.4), so the harness needs nothing installed and nothing added to any package.json.
 *
 * Usage:
 *     node cdp_driver.mjs --mailbox /tmp/enc-qa            # long-running
 *     node cdp_client.mjs /tmp/enc-qa eval "document.title"
 *
 * Commands (JSON objects, one per file in <mailbox>/in). Every answer is snake_case: CDP's
 * camelCase is converted here, so nothing reads two dialects out of one mailbox.
 *     {"op":"eval","expr":"...","seconds":60} Runtime.evaluate, awaits promises, userGesture.
 *                                            Answers {"value":...}, or {"page_error":"..."}
 *                                            when the expression threw. `seconds` bounds the
 *                                            evaluation (default 60, which is the app's own
 *                                            WebAuthn timeout).
 *     {"op":"nav","url":"..."}               Page.navigate and wait for load
 *     {"op":"reload"}                        real reload (unlike location.hash)
 *     {"op":"initscript","source":"..."}     Page.addScriptToEvaluateOnNewDocument
 *     {"op":"auth_add"}                      add a virtual authenticator -> authenticator_id
 *     {"op":"auth_remove","id":"..."}        drop one (models a lost device)
 *     {"op":"auth_list"}                     ids currently attached
 *     {"op":"auth_creds","id":"..."}         credentials stored in one authenticator
 *     {"op":"offline","value":true}          Network.emulateNetworkConditions
 *     {"op":"net"}                           drain the recorded requests (with post bodies)
 *     {"op":"console"}                       drain console messages, log entries, exceptions
 *     {"op":"screenshot","path":"..."}       Page.captureScreenshot to a file
 *     {"op":"viewport","width":390,"height":844,"mobile":false}
 *     {"op":"quit"}
 *
 * `error` is this driver failing — an unknown op, an unparsable command file, a CDP call that
 * threw — and never the page: an expected in-page throw is `page_error`, so a scenario can
 * assert one without the other passing for it.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

// Overridable because the binary is packaged under a different path on every distro.
const CHROME = process.env.QA_CHROME || '/opt/google/chrome/chrome'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class CDP {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 0
    this.pending = new Map()
    this.onEvent = () => {}
  }

  async connect() {
    // Node's own global WebSocket, so this file has no dependency to install.
    this.ws = new WebSocket(this.url)
    this.ws.addEventListener('message', (event) => this.receive(event.data))
    this.ws.addEventListener('close', () => this.failPending(new Error('CDP socket closed')))
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error(`cannot open ${this.url}`)), {
        once: true,
      })
    })
  }

  receive(raw) {
    const msg = JSON.parse(raw)
    if (msg.id === undefined) {
      this.onEvent(msg)
      return
    }
    const waiting = this.pending.get(msg.id)
    this.pending.delete(msg.id)
    waiting?.settle(msg)
  }

  failPending(error) {
    for (const waiting of this.pending.values()) waiting.fail(error)
    this.pending.clear()
  }

  send(method, params = {}, sessionId = null, timeoutMs = 60000) {
    const id = ++this.nextId
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: no answer in ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        settle: (msg) => {
          clearTimeout(timer)
          if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`))
          else resolve(msg.result ?? {})
        },
        fail: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.ws.send(JSON.stringify(payload))
    })
  }
}

async function launchChrome(port, profile) {
  // A fresh profile every run, so a scenario cannot inherit the localStorage or the
  // IndexedDB-held key of the one before it and pass for the wrong reason.
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1000,900',
    ],
    { stdio: 'ignore' },
  )
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      const version = await res.json()
      return { proc, wsUrl: version.webSocketDebuggerUrl }
    } catch {
      await sleep(200)
    }
  }
  proc.kill('SIGKILL')
  throw new Error('Chrome did not open the debugging port')
}

/**
 * CDP answers in camelCase and this mailbox speaks snake_case. The `auth_*` replies are handed
 * back whole rather than projected — a stored credential carries optional fields (`largeBlob`,
 * `backupEligibility`) that a hand-written projection would silently drop — so their keys are
 * converted instead.
 */
const snakeKeys = (value) => {
  if (Array.isArray(value)) return value.map(snakeKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      snakeKeys(v),
    ]),
  )
}

/**
 * One recorded request, as `net` hands it back. `status` is an int or null and never anything
 * else — a transport failure goes in `error` — so `r.status >= 400` cannot compare a string.
 */
function requestJson(record) {
  // Everything but `requestId`, which is CDP's handle for matching the events of one request up
  // and for fetching its body, and means nothing to a scenario reading the drain.
  return {
    method: record.method,
    url: record.url,
    // snake_case because these are the mailbox protocol's wire names for CDP's
    // postData/hasPostData.
    post_data: record.postData,
    has_post_data: record.hasPostData,
    status: record.status,
    error: record.error,
  }
}

class Driver {
  constructor(cdp, session, mailbox) {
    this.cdp = cdp
    this.session = session
    this.mailbox = mailbox
    this.authenticators = []
    this.requests = []
    this.console = []
    this.loads = 0
  }

  pumpEvent(msg) {
    const { method, params = {} } = msg
    if (method === 'Network.requestWillBeSent') {
      this.requests.push({
        requestId: params.requestId,
        method: params.request.method,
        url: params.request.url,
        postData: params.request.postData ?? null,
        hasPostData: params.request.hasPostData ?? false,
        status: null,
        error: null,
      })
    } else if (method === 'Network.responseReceived') {
      const record = this.requests.find((r) => r.requestId === params.requestId)
      if (record) record.status = params.response.status
    } else if (method === 'Network.loadingFailed') {
      const record = this.requests.find((r) => r.requestId === params.requestId)
      if (record) record.error = params.errorText ?? ''
    } else if (method === 'Runtime.consoleAPICalled') {
      const args = (params.args ?? [])
        .map((a) => String(a.value ?? a.description ?? a.type))
        .join(' ')
      this.noteConsole(`console.${params.type}`, args)
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails
      this.noteConsole('exception', details.exception?.description || details.text)
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry
      this.noteConsole(`log.${entry.level}`, `${entry.text} ${entry.url ?? ''}`)
    } else if (method === 'Page.loadEventFired') {
      this.loads += 1
    }
  }

  noteConsole(kind, text) {
    // One shape from three events — a console call, an uncaught exception and a browser log
    // entry — so a scenario reads `kind` and `text` without caring which of them it came from.
    this.console.push({ kind, text: text || '' })
  }

  async waitLoad(before, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.loads > before) return true
      await sleep(50)
    }
    return false
  }

  async handle(cmd) {
    const s = this.session

    if (cmd.op === 'eval') {
      // The default matches `utils/passkey.js`'s own `TIMEOUT_MS`: a prompt no authenticator
      // answers takes a full minute to give up, and a shorter deadline would kill the
      // evaluation first and report a terminated expression instead of what the app showed.
      const seconds = cmd.seconds ?? 60
      const res = await this.cdp.send(
        'Runtime.evaluate',
        {
          expression: cmd.expr,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          timeout: seconds * 1000,
        },
        s,
        // Slack over the in-page deadline, so an expression that runs out of time answers with
        // the page's own error rather than with the socket giving up first.
        (seconds + 10) * 1000,
      )
      // The page threw, which a scenario may well be asserting — hence its own key, so it is
      // never confused with this driver failing.
      if (res.exceptionDetails) {
        const d = res.exceptionDetails
        return { page_error: d.exception?.description || d.text }
      }
      // `?? null`, so the reply always has a `value`: an expression yielding `undefined` would
      // otherwise serialise to `{}` and read as an empty answer.
      return { value: res.result?.value ?? null }
    }

    if (cmd.op === 'nav') {
      const before = this.loads
      await this.cdp.send('Page.navigate', { url: cmd.url }, s)
      return { loaded: await this.waitLoad(before) }
    }

    if (cmd.op === 'reload') {
      // The real thing, which is the only way to test a cold start: `location.hash = ...`
      // re-renders the SPA with the store, the session key and the caches all still in
      // memory, so it proves nothing about what happens on a genuine reopen.
      const before = this.loads
      await this.cdp.send('Page.reload', { ignoreCache: true }, s)
      return { loaded: await this.waitLoad(before) }
    }

    if (cmd.op === 'initscript') {
      // At document start, because the store rewrites its plaintext cache ~300ms after boot:
      // the same source run as an ordinary `eval` loses that race.
      return snakeKeys(
        await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: cmd.source }, s),
      )
    }

    if (cmd.op === 'auth_add') {
      const res = await this.cdp.send(
        'WebAuthn.addVirtualAuthenticator',
        {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            // These four mirror the app's own authenticatorSelection: a discoverable
            // credential, UV that always succeeds, and no touch to simulate. Drop one and
            // create() fails as NotAllowedError.
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
            // The whole reason this harness exists: without it `create()` returns no
            // `prf.results.first` and none of the app's key wrapping can run.
            hasPrf: true,
          },
        },
        s,
      )
      this.authenticators.push(res.authenticatorId)
      return snakeKeys(res)
    }

    if (cmd.op === 'auth_remove') {
      await this.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: cmd.id }, s)
      this.authenticators = this.authenticators.filter((id) => id !== cmd.id)
      return { removed: cmd.id, left: this.authenticators }
    }

    if (cmd.op === 'auth_list') {
      return { authenticators: this.authenticators }
    }

    if (cmd.op === 'auth_creds') {
      const res = await this.cdp.send('WebAuthn.getCredentials', { authenticatorId: cmd.id }, s)
      for (const credential of res.credentials ?? []) delete credential.privateKey
      return snakeKeys(res)
    }

    if (cmd.op === 'offline') {
      const offline = Boolean(cmd.value)
      await this.cdp.send(
        'Network.emulateNetworkConditions',
        { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        s,
      )
      return { offline }
    }

    if (cmd.op === 'net') {
      for (const record of this.requests) {
        // `requestWillBeSent` leaves a large body out, and the body is the whole point here: it
        // is where a plaintext leak would show up. Fetched on drain rather than on arrival,
        // since most requests never get asked about.
        if (record.hasPostData && !record.postData) {
          try {
            const got = await this.cdp.send(
              'Network.getRequestPostData',
              { requestId: record.requestId },
              s,
            )
            record.postData = got.postData ?? null
          } catch {
            // The body is gone from Chrome's cache; the record is still worth handing back.
          }
        }
      }
      const out = this.requests.map(requestJson)
      this.requests = []
      return { requests: out }
    }

    if (cmd.op === 'console') {
      const out = this.console
      this.console = []
      return { messages: out }
    }

    if (cmd.op === 'screenshot') {
      const res = await this.cdp.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true },
        s,
      )
      fs.writeFileSync(cmd.path, Buffer.from(res.data, 'base64'))
      return { path: cmd.path }
    }

    if (cmd.op === 'viewport') {
      await this.cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: cmd.width,
          height: cmd.height,
          deviceScaleFactor: 1,
          mobile: Boolean(cmd.mobile),
        },
        s,
      )
      return { viewport: [cmd.width, cmd.height] }
    }

    if (cmd.op === 'quit') {
      return { bye: true }
    }

    return { error: `unknown op ${cmd.op}` }
  }

  async serve() {
    const inbox = path.join(this.mailbox, 'in')
    const outbox = path.join(this.mailbox, 'out')
    fs.mkdirSync(inbox, { recursive: true })
    fs.mkdirSync(outbox, { recursive: true })
    for (;;) {
      const files = fs
        .readdirSync(inbox)
        .filter((name) => name.endsWith('.json'))
        .sort()
      if (files.length === 0) {
        await sleep(50)
        continue
      }
      for (const name of files) {
        const file = path.join(inbox, name)
        let cmd = null
        let unparsable = null
        try {
          cmd = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (error) {
          unparsable = String(error)
        }
        fs.unlinkSync(file)
        let result
        // Answered here rather than through `handle`, which would have nothing but the op to
        // report and would name the wrong cause: an unparsable file has no op.
        if (unparsable) {
          result = { error: `unparsable command file ${name}: ${unparsable}` }
        } else {
          try {
            result = await this.handle(cmd)
          } catch (error) {
            result = { error: `${error.name}: ${error.message}` }
          }
        }
        const tmp = path.join(outbox, `${name}.tmp`)
        fs.writeFileSync(tmp, JSON.stringify(result))
        fs.renameSync(tmp, path.join(outbox, name))
        if (cmd?.op === 'quit') return
      }
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '9333' },
      profile: { type: 'string', default: '/tmp/enc-qa-chrome-profile' },
      mailbox: { type: 'string', default: '/tmp/enc-qa-mailbox' },
      url: { type: 'string', default: 'about:blank' },
    },
  })
  const port = Number(values.port)

  for (const sub of ['in', 'out']) {
    const dir = path.join(values.mailbox, sub)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  }

  const { proc, wsUrl } = await launchChrome(port, values.profile)
  // Ctrl-C in the terminal that started the driver must not leave a headless Chrome running:
  // nothing else knows its pid once `ready.json` is gone.
  process.on('SIGINT', () => {
    proc.kill('SIGKILL')
    process.exit(0)
  })

  const cdp = new CDP(wsUrl)
  await cdp.connect()

  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const session = attached.sessionId

  for (const domain of ['Page', 'Runtime', 'Network', 'Log', 'DOM']) {
    await cdp.send(`${domain}.enable`, {}, session)
  }
  await cdp.send('WebAuthn.enable', { enableUI: false }, session)

  const driver = new Driver(cdp, session, values.mailbox)
  cdp.onEvent = (msg) => driver.pumpEvent(msg)

  // One authenticator from the start, before any page has loaded: registration is the first
  // thing a scenario does, and `create()` fails outright with none attached.
  const first = await driver.handle({ op: 'auth_add' })
  if (values.url !== 'about:blank') {
    await driver.handle({ op: 'nav', url: values.url })
  }

  const ready = {
    // Chrome's, not this process's: what it is for is `kill`ing a browser left behind by a
    // driver that died, which the mailbox cannot do anything about.
    chrome_pid: proc.pid,
    port,
    mailbox: values.mailbox,
    authenticator: first.authenticator_id,
  }
  fs.writeFileSync(path.join(values.mailbox, 'ready.json'), JSON.stringify(ready))
  console.log(JSON.stringify(ready))

  try {
    await driver.serve()
  } finally {
    proc.kill('SIGTERM')
    const exited = await Promise.race([once(proc, 'exit').then(() => true), sleep(10000)])
    if (!exited) proc.kill('SIGKILL')
    cdp.ws.close()
  }
  console.log('driver stopped')
}

await main()
