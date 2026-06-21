# local-books

A headless CLI that mirrors a QuickBooks Online company into a local SQLite database and keeps it current with incremental Change Data Capture (CDC). The mirror is a faithful, re-pullable cache: QuickBooks owns authoritative history, CDC drives upserts into current state.

## Commands

```
local-books auth                              # one-time OAuth2 (localhost callback), tokens -> OS keyring
local-books sync [--full] [--entity <name>]   # refresh the mirror; mode is chosen from stored state
local-books status                            # token state + per-entity cursor, row counts, last full pull
```

`sync` chooses FULL vs INCREMENTAL per entity from stored `_sync_state`: a first run, a cursor older than the CDC 30-day window, or a stale full-pull backstop forces FULL; otherwise it runs CDC since the last cursor. `--full` forces FULL.

## Setup

You need an Intuit developer app (https://developer.intuit.com → your app → Keys & credentials). Use the **sandbox / development** keys to mirror a sandbox company. Register `http://localhost:8765/callback` as a redirect URI on the app.

Provide the keys by environment:

```sh
export QB_CLIENT_ID=...        # or LOCAL_BOOKS_QB_CLIENT_ID
export QB_CLIENT_SECRET=...    # or LOCAL_BOOKS_QB_CLIENT_SECRET
```

In this monorepo the keys live in Infisical at `/apps/local-books`, so prefix any command:

```sh
infisical run --path=/apps/local-books -- bun run src/bin.ts auth
infisical run --path=/apps/local-books -- bun run src/bin.ts sync --entity Invoice --full
infisical run --path=/apps/local-books -- bun run src/bin.ts status
```

## Where things live

```
<data-dir>/<realmId>/books.db   # entity tables + _sync_state + _meta
OS keyring (keyed by realmId)    # OAuth tokens, never the data dir
<data-dir>/config.json           # optional: entities, environment, schedule
```

`<data-dir>` defaults to the OS app-data path (`~/Library/Application Support/local-books` on macOS), overridable with `--data-dir` or `LOCAL_BOOKS_DIR`. `--env sandbox|production` (default `sandbox`) selects the QuickBooks API.

Tokens go in the OS keyring (macOS `security`, Linux `secret-tool`). On a headless box without a keyring daemon, or in CI, set `LOCAL_BOOKS_KEYRING_FILE=<path>` to use a plaintext file store instead.

## Build a single binary

```sh
bun run build:binary        # -> dist/local-books
```

## Keeping it fresh

Run a sync whenever you want current data:

```sh
local-books sync
```

Or keep it syncing in the background with `--interval`:

```sh
local-books sync --interval 30m
```

That runs a sync now and again every 30 minutes until you stop it with Ctrl-C. The first pass honors `--full`; every pass after that is incremental, so `--full --interval` means "one full pull, then keep up with CDC". In this monorepo:

```sh
infisical run --path=/apps/local-books -- bun run src/bin.ts sync --interval 30m
```

`sync` is stateless across runs (the cursor lives in the db), so it is safe to stop and restart anytime. To keep it running across logout or reboot, wrap that command in a launchd `KeepAlive` agent (macOS) or a systemd user service — you only need that once this graduates from an experiment.

## Develop

```sh
bun test            # boots a mock QuickBooks server and drives the real command paths
bun run typecheck
bun run test/demo-e2e.ts   # end-to-end demo against the mock (full pull -> incremental)
```
