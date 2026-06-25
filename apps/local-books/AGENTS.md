# local-books

Headless CLI that mirrors a QuickBooks Online company into a local SQLite database and keeps it current with incremental Change Data Capture (CDC). This is a faithful, re-pullable mirror, not a ledger: QuickBooks owns authoritative history, CDC drives upserts into current state.

Design authority: `specs/20260621T100000-local-books-cli-sync-engine.md` (top-level specs dir). Read it before changing the sync model.

## Shape

- Runtime: Bun. `bun:sqlite` for storage, built-in `fetch` for the QB API, `oauth4webapi` for the OAuth2 grants (the same client `@epicenter/auth` uses; we own only the localhost callback and the QuickBooks-specific `realmId`). Runtime deps are pure-TS and dependency-free so `bun build --compile` yields one binary: `wellcrafted` (Result/error idioms), `typebox` (validating untrusted token grants and `config.json`), and `oauth4webapi`. All three are cataloged and used elsewhere in the monorepo.
- One SQLite file per company: `<data-dir>/<realmId>/books.db`. Tokens live in a `0600` `credentials.json` at the data-dir root, never inside a company's mirror db, so the agent's read-only SQL surface can never read them. See ADR-0061. The realm's one CDC cursor lives in the db (`_meta`), not a sidecar, so ingest-and-advance is one transaction; whether an entity has been full-pulled is derived from table existence, so there is no per-entity sync-state table. See ADR-0063.
- One table per QB entity (`invoices`, `customers`, ...): `id`, `raw` (verbatim QB JSON), `updated_at`, `synced_at`, `deleted`, plus a few extracted scalar columns for indexing/joins. New QB fields land in `raw` with no migration.

## Grounded QB constants (verified against developer.intuit.com, 2026-06-21)

- CDC lookback window: 30 days. Past that, CDC cannot cover the gap, so the engine forces a FULL pull. `CDC_SAFE_WINDOW_DAYS` keeps a margin under 30.
- CDC max objects per response: 1000 per entity.
- Rate limits: 500 req/min per realmId, 10 concurrent, 40 batch/min. 429 `ThrottleExceeded` (errorCode 003001) → back off ~60s.
- Deletes: CDC returns deleted entities carrying `status: "Deleted"` + `Id` + `MetaData.LastUpdatedTime`. We soft-delete (`deleted = 1`), never hard-delete: a CDC delete means QB no longer has the object, so the local blob is the only surviving copy.

## CLI

```
local-books auth                              # one-time OAuth2 (localhost callback), tokens -> credentials.json
local-books sync [--full] [--entity <name>...]
local-books status
```

Mode is chosen from stored state: `--full` / no cursor / cursor older than the CDC window / full-pull staleness backstop → FULL; otherwise INCREMENTAL.

## Config (env or `<data-dir>/config.json`)

- `QB_CLIENT_ID` / `QB_CLIENT_SECRET` — your Intuit app keys (required for `auth`). This is what Infisical injects at `/apps/local-books`, so the usual invocation is `infisical run --path=/apps/local-books -- bun run src/bin.ts auth`.
- `LOCAL_BOOKS_QB_ENV` — `sandbox` (default) or `production`.
- `LOCAL_BOOKS_DIR` / `--data-dir` — data directory override.
- `LOCAL_BOOKS_TOKEN_FILE` — override the token file path (default `<data-dir>/credentials.json`). Used by the test harness and any custom location. The `0600` file store works the same on a desktop, a headless server, an SSH session, and CI, which is what a headless-first tool needs. See ADR-0061.
- `LOCAL_BOOKS_READ_ONLY` — serve the agent a read-only surface (both reads, no `recategorize_expense` write tool). See the agent-surface capability lattice below.
- Base-URL overrides (`LOCAL_BOOKS_QB_API_BASE`, `_TOKEN_URL`, `_AUTHORIZE_URL`) point the client at a mock server for tests.

## Agent surface (ADR-0047, ADR-0060)

`books.ts` + `mount.ts` wrap the mirror as an Epicenter **data daemon**: it holds the SQLite and serves it as dispatched actions, but never runs inference. A client agent loop (`@epicenter/workspace/agent`) opens the same synced room and dispatches the tools; the financial data leaves the machine only as a tool result. Sourcing rule (ADR-0060): mirror the *facts* (rows), ask QuickBooks for the *opinions* it computes (reports); the mirror is never the write target.

- `src/agent/books-query.ts` — `books_sql_query`, open read-only SQL over the **local mirror** (`query`, auto-approved). Enforced read-only by a `new Database(path, { readonly: true })` connection, not a string check; results are row-capped. The high-volume, offline, row-level surface.
- `src/agent/report.ts` — `books_report`, a **live** QuickBooks Reports API read (`query`, auto-approved): P&L, balance sheet, cash flow, A/R + A/P aging, trial balance. Never mirrored, never cached (reports have no CDC, so a cache would be a stale snapshot); one cheap call for whole-ledger aggregates.
- `src/agent/recategorize.ts` — `recategorize_expense`, the one QuickBooks write-back (`mutation`, so the loop pauses for approval). Write-THROUGH, never write-to-mirror: it reads the `SyncToken` from the mirror, sparse-updates the expense line `AccountRef` on a Purchase/Bill via `qb.update(...)`, then folds QuickBooks' authoritative response back into the mirror; the next CDC sync reconfirms it. A stale `SyncToken` is a 409, never a clobber. `src/agent/qb-access.ts` (`createQbAccess`) lazily opens a QB client from the realm's token store, so this layer holds no credentials directly.
- `src/agent/books-actions.ts` — `createBooksAgentActions({ dbPath, openQb?, readOnly? })`, a **capability lattice** so the agent is only offered what the daemon can do: `books_sql_query` always; `books_report` when `openQb` is present; `recategorize_expense` when `openQb` is present and not `readOnly`. No `openQb` = fully-offline, mirror-only; `readOnly` (env `LOCAL_BOOKS_READ_ONLY`) = both reads, no write. Local annotation tools (`mark_reviewed`, `add_note`) remain parked in the spec.

The CLI binary (`bin.ts` -> `cli.ts`) does not import this layer, so `bun build --compile` of the CLI stays lean.

## Testing

`bun test` boots a mock QB server (`test/mock-qb-server.ts`) and drives the real command paths against it (seeded token file), so full pull, incremental CDC, cursor advance, and soft-delete are proven end-to-end without a live sandbox. The interactive browser hop of `auth` is the only piece a live sandbox is needed for. The agent surface (`src/agent/`) is tested through the real dispatch catalog against a seeded mirror.
