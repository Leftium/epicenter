# local-books

Headless CLI that mirrors a QuickBooks Online company into a local SQLite database and keeps it current with incremental Change Data Capture (CDC). This is a faithful, re-pullable mirror, not a ledger: QuickBooks owns authoritative history, CDC drives upserts into current state.

Design authority: `specs/20260621T100000-local-books-cli-sync-engine.md` (top-level specs dir). Read it before changing the sync model.

## Shape

- Runtime: Bun. `bun:sqlite` for storage, built-in `fetch` for the QB API, hand-rolled OAuth2 (authorization-code, localhost callback). Zero heavy runtime deps so `bun build --compile` yields one binary. `wellcrafted` is the only runtime dependency (Result/error idioms, pure TS).
- One SQLite file per company: `<data-dir>/<realmId>/books.db`. Tokens live in the OS keyring (never the data dir). Sync state lives in the db (`_sync_state`), not a sidecar, so ingest-and-advance is one transaction.
- One table per QB entity (`invoices`, `customers`, ...): `id`, `raw` (verbatim QB JSON), `updated_at`, `synced_at`, `deleted`, plus a few extracted scalar columns for indexing/joins. New QB fields land in `raw` with no migration.

## Grounded QB constants (verified against developer.intuit.com, 2026-06-21)

- CDC lookback window: 30 days. Past that, CDC cannot cover the gap, so the engine forces a FULL pull. `CDC_SAFE_WINDOW_DAYS` keeps a margin under 30.
- CDC max objects per response: 1000 per entity.
- Rate limits: 500 req/min per realmId, 10 concurrent, 40 batch/min. 429 `ThrottleExceeded` (errorCode 003001) → back off ~60s.
- Deletes: CDC returns deleted entities carrying `status: "Deleted"` + `Id` + `MetaData.LastUpdatedTime`. We soft-delete (`deleted = 1`), never hard-delete: a CDC delete means QB no longer has the object, so the local blob is the only surviving copy.

## CLI

```
local-books auth                              # one-time OAuth2 (localhost callback), tokens -> keyring
local-books sync [--full] [--entity <name>...]
local-books status
```

Mode is chosen from stored state: `--full` / no cursor / cursor older than the CDC window / full-pull staleness backstop → FULL; otherwise INCREMENTAL.

## Config (env or `<data-dir>/config.json`)

- `LOCAL_BOOKS_QB_CLIENT_ID` / `LOCAL_BOOKS_QB_CLIENT_SECRET` — your Intuit app keys (required for `auth`). The bare `QB_CLIENT_ID` / `QB_CLIENT_SECRET` names are also accepted, which is what Infisical injects: `infisical run --path=/apps/local-books -- bun run src/bin.ts auth`.
- `LOCAL_BOOKS_QB_ENV` — `sandbox` (default) or `production`.
- `LOCAL_BOOKS_DIR` / `--data-dir` — data directory override.
- `LOCAL_BOOKS_KEYRING_FILE` — opt-in plaintext file token store (CI / headless boxes without a keyring daemon, and the test harness). Default is the OS keyring.
- Base-URL overrides (`LOCAL_BOOKS_QB_API_BASE`, `_OAUTH_BASE`, `_AUTH_BASE`) point the client at a mock server for tests.

## Testing

`bun test` boots a mock QB server (`test/mock-qb-server.ts`) and drives the real command paths against it (seeded file keyring), so full pull, incremental CDC, cursor advance, and soft-delete are proven end-to-end without a live sandbox. The interactive browser hop of `auth` is the only piece a live sandbox is needed for.
