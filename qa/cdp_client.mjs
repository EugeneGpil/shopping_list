#!/usr/bin/env node
/**
 * Send one command to a running `cdp_driver.mjs` and print the JSON answer.
 *
 *     node cdp_client.mjs --help                 # every op and its arguments
 *     node cdp_client.mjs <mailbox> <op> [args]
 *
 * `OPS` below is the only list of the ops this accepts: the usage text is printed from it, so
 * the two cannot drift. What each op does is the docstring of `cdp_driver.mjs`.
 *
 * Snippets loaded from a file go through `expand` first, so nothing under `js/` has to carry a
 * token or a uid that will rot — see that function.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Generous, because a step can be a real page load plus an unlock: the driver answers as soon
// as it is done, so this only decides how long a hung one is waited on.
const TIMEOUT_MS = 120000

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function die(message) {
  console.error(message)
  process.exit(1)
}

/**
 * Fill `{{QA_TOKEN}}`-style placeholders from the environment.
 *
 * Values are pasted into JS source, so they must not contain quotes — a sanctum token and a
 * firebase uid never do. `qa/README.md` has the command that mints them.
 */
function expand(source, origin) {
  const missing = new Set()
  const filled = source.replace(PLACEHOLDER, (match, name) => {
    const found = process.env[name]
    // An empty value counts as missing: substituted, the planted token is '' and src/api.js sends
    // no Authorization header at all, so every call 401s and reads as a bug in the app under test.
    if (found === undefined || found === '') {
      missing.add(name)
      return match
    }
    return found
  })
  if (missing.size > 0) {
    die(`${origin}: not set in the environment: ${[...missing].sort().join(', ')}`)
  }
  return filled
}

function readExpanded(file) {
  return expand(fs.readFileSync(file, 'utf8'), file)
}

const truthy = (value) => ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase())
const optionalSeconds = (value) => (value === undefined ? undefined : Number(value))

/**
 * Every op, its arguments and the envelope it becomes. `-file` variants are this side only:
 * they read the file and expand it, and the driver sees the ordinary op.
 */
const OPS = {
  eval: {
    args: '<expr> [seconds]',
    build: ([expr, wait]) => ({ op: 'eval', expr, seconds: optionalSeconds(wait) }),
  },
  'eval-file': {
    args: '<file> [seconds]',
    build: ([file, wait]) => ({
      op: 'eval',
      expr: readExpanded(file),
      seconds: optionalSeconds(wait),
    }),
  },
  'initscript-file': {
    args: '<file>',
    build: ([file]) => ({ op: 'initscript', source: readExpanded(file) }),
  },
  nav: { args: '<url>', build: ([url]) => ({ op: 'nav', url }) },
  reload: {},
  auth_add: {},
  auth_list: {},
  auth_remove: { args: '<authenticatorId>', build: ([id]) => ({ op: 'auth_remove', id }) },
  auth_creds: { args: '<authenticatorId>', build: ([id]) => ({ op: 'auth_creds', id }) },
  offline: { args: 'true|false', build: ([value]) => ({ op: 'offline', value: truthy(value) }) },
  net: {},
  console: {},
  screenshot: { args: '<path>', build: ([file]) => ({ op: 'screenshot', path: file }) },
  viewport: {
    args: '<width> <height> [mobile]',
    build: ([width, height, mobile]) => ({
      op: 'viewport',
      width: Number(width),
      height: Number(height),
      mobile: truthy(mobile),
    }),
  },
  quit: {},
}

const usage = () =>
  [
    'usage: node cdp_client.mjs <mailbox> <op> [args]',
    '',
    ...Object.entries(OPS).map(([name, spec]) => `  ${name} ${spec.args ?? ''}`.trimEnd()),
  ].join('\n')

function build(argv) {
  const [op, ...rest] = argv
  const spec = OPS[op]
  if (!spec) return die(`unknown op ${op ?? '(none given)'}\n\n${usage()}`)
  return spec.build ? spec.build(rest) : { op }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage())
  process.exit(0)
}

const mailbox = process.argv[2]
const cmd = build(process.argv.slice(3))
// Timestamped so the driver takes queued commands in the order they were sent, and made
// unique so two clients cannot name the same file.
const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`
const inbox = path.join(mailbox, 'in')
const outbox = path.join(mailbox, 'out')
// Written aside and renamed into place: the driver polls the directory, and a rename is
// atomic, so it can never read half a command.
const tmp = path.join(inbox, `${name}.tmp`)
fs.writeFileSync(tmp, JSON.stringify(cmd))
fs.renameSync(tmp, path.join(inbox, name))

const answer = path.join(outbox, name)
const deadline = Date.now() + TIMEOUT_MS
while (Date.now() < deadline) {
  if (fs.existsSync(answer)) {
    console.log(fs.readFileSync(answer, 'utf8'))
    fs.unlinkSync(answer)
    process.exit(0)
  }
  await sleep(50)
}
die('driver did not answer')
