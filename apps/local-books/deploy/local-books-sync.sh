#!/bin/sh
# local-books-sync.sh — run a scheduled `local-books sync`.
#
# OAuth tokens live in the OS keyring (from `local-books auth`); this wrapper
# only loads the QuickBooks *client* credentials needed to refresh an expired
# access token unattended, from a 0600 env file, then runs a sync. Point a
# launchd/systemd unit at this script.
set -eu

# Client credentials + options. Copy deploy/local-books.env.example here and
# `chmod 600` it. The OAuth tokens are NOT in this file; they are in the keyring.
ENV_FILE="${LOCAL_BOOKS_ENV_FILE:-$HOME/.config/local-books/env}"
if [ -f "$ENV_FILE" ]; then
	set -a
	. "$ENV_FILE"
	set +a
fi

# Path to the installed single binary (bun build --compile). Override with
# LOCAL_BOOKS_BIN, e.g. to a `bun run /path/to/src/bin.ts` shim.
BIN="${LOCAL_BOOKS_BIN:-/usr/local/bin/local-books}"

exec "$BIN" sync "$@"
