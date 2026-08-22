#!/usr/bin/env bash
# Bring up the CDP driver and log the fake session in — the steps every encryption scenario
# starts with. Everything after this is `node cdp_client.mjs <mailbox> <op> ...`.
#
#   QA_TOKEN=... ./run.sh            # starts the driver, prints the mailbox path
#   node cdp_client.mjs "$MB" eval 'window.__qa.text()'
#   node cdp_client.mjs "$MB" reload && node cdp_client.mjs "$MB" eval-file js/signin.js
#   node cdp_client.mjs "$MB" quit
#
# `node cdp_client.mjs --help` prints every op and its arguments.
#
# Keep a single driver process for a whole scenario: the virtual authenticator dies with the CDP
# session, and a wrapped DEK whose authenticator is gone can never be unwrapped again.
#
# See qa/README.md for seeding the user this signs in as, and for the rest of the constraints.
set -euo pipefail
cd "$(dirname "$0")"

# The uid the fixtures use; `js/` carries the name, not the value (see `expand` in cdp_client.mjs).
export QA_UID="${QA_UID:-enc-qa}"

if [ -z "${QA_TOKEN:-}" ]; then
  echo "QA_TOKEN is not set — see the 'Seeding' section of qa/README.md." >&2
  exit 1
fi

MB="${1:-/tmp/enc-qa-mailbox}"
FRONT="${FRONT_URL:-http://localhost:9200/}"

# Two drivers on one mailbox take each other's commands and wipe each other's in/out
# directories, so the rule above shows up as a client that waits its full timeout and then says
# the driver never answered. And a `ready.json` left by a dead run has to go, or the wait below
# returns the previous run's authenticator id instantly.
if pgrep -f "cdp_driver.mjs --mailbox $MB" >/dev/null; then
  echo "a driver is already running on $MB — send it 'quit' first." >&2
  exit 1
fi
rm -f "$MB/ready.json"

node cdp_driver.mjs --mailbox "$MB" >"$MB.log" 2>&1 &
until [ -f "$MB/ready.json" ]; do sleep 0.3; done
cat "$MB/ready.json"; echo

# Both as init scripts, before the first navigation: the token has to be in localStorage
# before `src/api.js` reads it, and the cache wipe has to beat the store's own rewrite.
node cdp_client.mjs "$MB" initscript-file js/helpers.js
node cdp_client.mjs "$MB" initscript-file js/wipe_init.js
node cdp_client.mjs "$MB" nav "$FRONT"
node cdp_client.mjs "$MB" eval-file js/signin.js
echo "mailbox: $MB"
