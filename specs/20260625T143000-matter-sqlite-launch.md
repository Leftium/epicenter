# Matter: the SQLite launch (query engine, FTS, and the `epicenter matter` CLI)

**Date**: 2026-06-25
**Status**: Draft
**Owner**: Braden
**Branch**: `matter-sqlite-launch` (suggested; work not yet started)

## One Sentence

Make Matter's SQLite mirror a first-class surface by unifying the grid's filter, sort, and full-text search into one read-only SQL query (with a raw SQL console as its power face), projecting markdown bodies into per-folder FTS5 tables, and extracting matter's lint engine into `packages/matter-core` so the `epicenter` binary can ship `epicenter matter check`, all without touching the truth model: markdown on disk stays the source, `matter.sqlite` stays a disposable read-only projection.

## How to read this spec

```
Read first:
  One Sentence
  Overview
  Motivation (Current State, Problems, Desired State)
  The boundary (the one architectural rule)
  Implementation Plan
  Success Criteria

Read if changing the architecture:
  Research Findings
  Design Decisions
  Architecture
  Catalogs
  Call sites: before and after

Decide these:
  Open Questions

Not in this launch:
  Adjacent Work
```

## Overview

Matter already turns a folder of markdown into a typed SQLite mirror, but the only window onto that SQL is a one-line `WHERE` box and the database is hidden. This spec promotes SQLite to the headline: a real read-only SQL console, sortable columns and full-text body search built on the same query path, a visible "Database" panel, and a `matter check` lint command that ships inside the published `epicenter` binary.

## Motivation

### Current State

The mirror is real and already executes arbitrary read-only SQL, but nothing surfaces it. The only consumer wraps it in a canned `SELECT "stem"`:

```ts
// apps/matter/src/lib/mirror.svelte.ts:84
function query(name: string, where: string): Promise<Result<Set<string>, ...>> {
  const sql = `SELECT "stem" FROM ${quoteIdent(name)} WHERE ${where}`;
  // invoke('query_mirror', { root, sql, limit: null }) -> { columns, rows }
  // ...only row[0] (the stem) is kept; columns and other cells are discarded.
}
```

```rust
// apps/matter/src-tauri/src/mirror.rs:159  (already arbitrary, read-only)
pub fn query_mirror(root, sql, limit) -> Result<QueryResult, String>  // { columns, rows }
```

The markdown body is parsed into memory on every row but dropped at the projector, so prose is unqueryable:

```ts
// apps/matter/src/lib/core/sqlite.ts:152  (c.row.body is never read)
return [stemOf(c.row.fileName), ...cells, extra];
```

The lint engine lives inside the app, unreachable from the `epicenter` binary (a package cannot import an app):

```ts
// apps/matter/src/cli/check.ts  ->  imports ../lib/core/* and ../lib/load/fs
// packages/cli/src/cli.ts  ->  has no `matter` command
```

This creates problems:

1. **"SQLite" is unbacked.** The headline word maps to a hidden, read-only mirror behind a single `WHERE` box. No console, no `SELECT`, no `JOIN`, no export.
2. **The prose half of every row is invisible to query.** Frontmatter becomes columns; the body, where most life-text lives, is dropped at the projector and can only be read by opening a row.
3. **No CLI in the shipped binary.** `matter check` runs only via `bun src/cli/check.ts` inside the app; agents and CI have no published lint entrypoint, and there is no `epicenter matter` surface.
4. **No sorting.** Row order is `SvelteMap` insertion order (`table.svelte.ts:108`); there is no `ORDER BY` and no clickable header.

### Desired State

One read-only SQL engine drives every read. The grid's filter, sort, and search are builders for a single query; the console is the same engine with raw SQL. Bodies are searchable via per-folder FTS5. `epicenter matter check <path>` ships in the binary. The truth model is unchanged.

## Research Findings

### The query engine already exists; the console is mostly frontend

`query_mirror` (`mirror.rs:159`) opens the db `SQLITE_OPEN_READ_ONLY`, runs the caller's SQL, and returns `QueryResult { columns: Vec<String>, rows: Vec<Vec<Value>> }`, serialized as `{ columns, rows }`. A test confirms it rejects writes. So a console needs: a TS pass-through that returns the full result (today's `query()` reduces it to a stem `Set`), a CodeMirror SQL editor, and a table that renders `{ columns, rows }`. No Rust change.

### The lint engine is pure and extracts cleanly

All thirteen files behind `matter check` are pure TypeScript with zero Svelte / Tauri / `$app` / browser coupling. `load/fs.ts` uses only `node:fs/promises` + `node:path`, which Bun implements, so `loadPath` already runs in a plain `bun` process. `cli/check.ts` transitively needs ten of them. No file needs splitting.

| File group | Files | Coupling |
| --- | --- | --- |
| `core/` (pure) | `contract`, `parse`, `conformance`, `integrity`, `violations`, `expected`, `sqlite`, `path`, `serialize`, `table` | none (only `@epicenter/field`, `wellcrafted/*`, `yaml`) |
| `load/` | `fs` | `node:fs/promises`, `node:path` (Bun-ok) |
| `report/` | `format`, `exit-code` | none |

**Implication**: `packages/matter-core` is a clean move of these files; `apps/matter` and `packages/cli` both depend on it. No new abstraction, no platform shim.

### FTS5 needs no Rust change

The workspace FTS reference (`packages/workspace/src/document/materializer/sqlite/fts.ts`) uses external-content FTS5: `CREATE VIRTUAL TABLE t_fts USING fts5(cols, content='t', content_rowid=rowid)` plus AFTER INSERT/DELETE/UPDATE triggers that mirror the base table. Matter's projector already emits a multi-statement `schema` string (`DROP … ; CREATE …`) that `write_mirror` runs through `execute_batch`, and rows are inserted right after. So if `projectToSqlite` appends the FTS5 `CREATE VIRTUAL TABLE` + triggers to that script, the triggers populate the index during the existing INSERT loop, and the full DROP/CREATE/INSERT rebuild keeps it in sync for free. Matter's Rust side uses `rusqlite`; this is a pattern port, not code reuse.

### Comparable surfaces (what to borrow, what to refuse)

| Tool | What it does well | Borrow | Refuse |
| --- | --- | --- | --- |
| Datasette | read-only SQL over SQLite, canned queries, JSON export | console + saved queries shape, "show the db" honesty | server/publish model (we are local desktop) |
| Obsidian Bases | frontmatter -> filtered views over local markdown | the "folder is a table" familiarity | GUI-only views, no SQL, no CLI |
| Dataview | live queries embedded in notes | live re-run on file change | a bespoke query language (we use SQL) |

**Key finding**: the differentiators competitors lack are *real SQL* + *a CLI/agent surface* + *typed conformance*. The launch leans into exactly those.

## The boundary (the one architectural rule)

This is the rule that resolves "all in on SQL" without breaking editing or the truth model:

```
SQL drives the QUERY:        which rows, in what order, matching what text.
The in-memory map drives the CELLS: their editable values and edits.
The console is READ-ONLY:    arbitrary SQL (JOIN/GROUP BY) has no row-to-file mapping.
The mirror stays a PROJECTION: edits write .md files; matter.sqlite is never a write target (ADR-0026).
```

Default view stays synchronous: when no `where`/`match`/`orderBy` is active, the grid renders directly from the in-memory `view.conformance` (instant first paint, `SvelteMap` order) and issues no SQL. SQL runs only when a query control is active. This preserves today's instant open and avoids making first paint async and `version`-gated.

Consequence to accept: sorting by a column and then editing that column updates the value instantly (in-memory) but re-settles the row's position after the next mirror rebuild. The freshness `version` gate (`mirror.svelte.ts:107`) already exists to coordinate this.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Cell rendering vs editing source | 2 coherence | Cells render/edit from the in-memory `SvelteMap`; SQL never backs editable cells | ADR-0026: mirror is a read-only projection; a JOIN/aggregate row has no file to write |
| Sort mechanism | 2 coherence | SQL `ORDER BY` in the unified query (not a second in-memory pass) | Search is already SQL (FTS); one engine selects + orders the row set; SQLite gives type-aware ordering free |
| Console scope | 2 coherence | Read-only, renders `{ columns, rows }` directly; "Edit as SQL" hands the grid's current query to it | Arbitrary SQL is not editable; reuses the existing read-only `query_mirror` |
| FTS implementation | 1 evidence | External-content FTS5 + triggers emitted into the projector `schema` string | Verified against `workspace/.../fts.ts`; `execute_batch` already runs multi-statement schema; no Rust change |
| `searchable` config | 2 coherence | Top-level `matter.json` key (sibling of `optional`); default = `body` + TEXT-storage fields | `contract.ts` doctrine: emptiness/policy axes live at top level, not in the field value schema. The key exists only because FTS5 exists |
| Project the body | 1 evidence | Add a `body TEXT` column to the base table; feed `c.row.body` (already in memory) | Body is parsed on every `Row` but currently dropped at `sqlite.ts:152` |
| `matter-core` contents | 1 evidence | Move all 13 pure files; nothing splits | Verified: zero Svelte/Tauri/browser coupling; `load/fs` is `node:fs` |
| CLI shape | 3 taste | `epicenter matter check` (namespaced subcommand), not a bare `matter` binary | Collision-free (`matter` is a crowded name); namespace quarantines disk-as-truth from the daemon/Yjs verbs; reversible (ship a `matter` alias later if Matter spins out) |
| Positioning/divergence | Recorded (ADR) | [ADR-0059](../docs/adr/0059-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md) (`Proposed`): Matter is a standalone disk-as-truth tool; mirror stays read-only; CLI is `epicenter matter` | Load-bearing and durable; lives in `docs/adr/`, not buried here. Builds on ADR-0026 |

## Architecture

The unified read path. One query builder; two faces (grid controls, raw console). One write path (files).

```
GRID controls                          SQL CONSOLE
  filter box ─┐                          raw SQL ─┐
  sort header ┤                                   │
  search box ─┤                                   │
              v                                   v
        buildQuery({where?, match?, orderBy?})   (verbatim)
              │                                   │
              └──────────────┬────────────────────┘
                             v
              query_mirror(root, sql, limit)   READ-ONLY (mirror.rs:159)
                             │
              ┌──────────────┴───────────────┐
              v                               v
   grid: ordered stems ──▶ render        console: { columns, rows }
   cells from in-memory map (editable)   rendered as read-only cells

EDIT path (unchanged):  cell edit ─▶ write .md ─▶ watcher ─▶ applyDeltas ─▶
                        SvelteMap (instant) + enqueue full re-projection ─▶ matter.sqlite
```

Query shapes the builder emits:

```sql
-- no search: filter + sort
SELECT "stem" FROM "books"
WHERE status = 'reading'            -- from the filter box (omitted if empty)
ORDER BY rating DESC                 -- from the sorted header (omitted if none)

-- with search: join the FTS table, rank or explicit sort
SELECT "books"."stem" AS stem
FROM "books_fts"
JOIN "books" ON "books".rowid = "books_fts".rowid
WHERE "books_fts" MATCH ?            -- from the search box
  AND status = 'reading'            -- filter still applies
ORDER BY rank                        -- or the chosen ORDER BY
```

## Catalogs

### The FTS5 schema the projector appends (per typed folder, when `searchable` is non-empty)

```sql
DROP TABLE IF EXISTS "books_fts";
CREATE VIRTUAL TABLE "books_fts"
  USING fts5("body", "title", content="books", content_rowid=rowid);
CREATE TRIGGER "books_fts_ai" AFTER INSERT ON "books" BEGIN
  INSERT INTO "books_fts"(rowid, "body", "title") VALUES (new.rowid, new."body", new."title");
END;
```

Only the AFTER INSERT trigger is needed. The projector rebuilds via full DROP/CREATE/INSERT and never UPDATEs or DELETEs a base row, so the workspace reference's AFTER DELETE / AFTER UPDATE triggers would never fire here; add them only if incremental sync lands later. The base table keeps an implicit `rowid` (it is not `WITHOUT ROWID`), so external-content FTS works; dropping the base table drops its triggers and the script recreates both tables together, so they never drift. FTS5 is compiled into matter's bundled `rusqlite` (`libsqlite3-sys` emits `-DSQLITE_ENABLE_FTS5`), so no Cargo change is required.

### The CLI surface (this launch)

```
epicenter matter check [path]      # lint a vault: conformance + reference integrity
epicenter matter check --json      # machine-readable violations; exit code 0/1/N
```

### Rejected / deferred CLI verbs (do not build now)

| Candidate | Why not now |
| --- | --- |
| `epicenter matter query` | `sqlite3 .matter/matter.sqlite` already does reads; build only when MCP shares the core |
| `epicenter matter add` | "edit the `.md`, then `check`" is the write loop; build when a headless writer (e.g. finance sync) needs it |
| `matter mcp` | reaches no-shell agent hosts; P1, not launch (Adjacent Work) |

## Call sites: before and after

These three show the *shape* of the change. The mechanical import repoint in Phase 1.3 is much broader (~20 files via the `$lib/core/*` alias); these are the semantically interesting edits.

### 1. The query driver (`apps/matter/src/lib/mirror.svelte.ts`)

**Before** (`:84`): one canned-shape query returning a stem `Set`.

```ts
function query(name: string, where: string): Promise<Result<Set<string>, { message: string }>> {
  const sql = `SELECT "stem" FROM ${quoteIdent(name)} WHERE ${where}`;
  // ...returns new Set(rows.map(r => String(r[0])))
}
```

**After**: a query builder returning ordered stems, plus a raw pass-through for the console and an FTS search.

```ts
// ordered, filtered, optionally text-matched stems for the grid
function runQuery(name, opts: { where?: string; match?: string; orderBy?: string }):
  Promise<Result<string[], { message: string }>> { /* builds the shapes above; ordered array, not Set */ }

// raw read-only SQL for the console (full result set)
function runSql(sql: string): Promise<Result<{ columns: string[]; rows: unknown[][] }, { message: string }>> {
  // invoke('query_mirror', { root, sql, limit: CONSOLE_LIMIT })
}
```

**Semantic shift to flag**: the grid filter now consumes an **ordered array**, not a `Set`; `TableGrid.svelte:90-98` (`filteredRows`) must preserve query order instead of intersecting a `Set` against insertion order.

### 2. The projector (`apps/matter/src/lib/core/sqlite.ts`, moving to `matter-core`)

**Before** (`buildDdl:112`, `projectToSqlite:152`): no body, no FTS.

```ts
const defs = [`"stem" TEXT PRIMARY KEY`, ...fields.map(...), `"_extra" TEXT NOT NULL`];
// rows: [stemOf(c.row.fileName), ...cells, extra]   // c.row.body dropped
```

**After**: a `body` column, FTS DDL appended when `searchable` is non-empty.

```ts
projectToSqlite(tableName, contract, conformance, searchable /* string[] | undefined */)
// DDL gains: `"body" TEXT`
// rows gain: c.row.body in the matching position
// schema gains: the FTS5 block from the catalog (only if searchable?.length)
```

### 3. The CLI entry (`apps/matter/src/cli/check.ts` -> `packages/cli`)

**Before**: `import { assess } from '../lib/core/integrity'` (and 5 more app-relative imports).

**After**: `import { assess, summarize, loadPath, formatReport, ... } from '@epicenter/matter-core'`, registered as `epicenter matter check`.

## Implementation Plan

### Phase 1: Extract `packages/matter-core` (Build, Prove, Remove)

- [ ] **1.1 Build** Scaffold `packages/matter-core` (package boilerplate per the `monorepo` skill). It must be a published, non-private package: the `epicenter` CLI ships raw TS and resolves `workspace:*` deps at install, so a private package would not install. Move the 13 pure files (`core/{contract,parse,conformance,integrity,violations,expected,sqlite,path,serialize,table}`, `load/fs`, `report/{format,exit-code}`) with their `.test.ts` siblings; keep internal relative imports intact; re-export the public surface from the package index.
- [ ] **1.2 Build** Fix the two tests that compute the bundled example-vault path from `import.meta.dir` with fixed offsets pinned to `apps/matter/src/lib/...`: `core/sqlite.test.ts` (~line 182) and `load/fs.test.ts` (~line 201). After the move those offsets resolve wrong and the tests fail; make them resolve `examples/matter/content-vault` independent of the file's location (walk up to the repo root, or inject the fixture path). This is a hard Prove blocker if skipped.
- [ ] **1.3 Build** Add `@epicenter/matter-core` as a dependency of `apps/matter` and `packages/cli`, and re-point every importer. This is broader than the 3 call sites below suggest: ~20 files in `apps/matter` import these modules via the `$lib/core/*` alias (the 11 field widgets; `ModeledCell`, `ReferenceVerdict`, `RowDetailDialog`, `TableGrid`, `IntegrityPanel`; `table.svelte.ts`, `vault.svelte.ts`; the `(vaults)` routes; and `mirror.svelte.ts`, which consumes the projector `core/sqlite.ts` and `quoteIdent`). Effectively the app's whole domain layer now lives in the package.
- [ ] **1.4 Prove** `bun run typecheck` + `bun test` green for `apps/matter` and `packages/matter-core` (including the relocated example-vault tests from 1.2).
- [ ] **1.5 Build** Add `packages/cli/src/commands/matter.ts` as a yargs command **group** following the `cmd()` helper pattern in `packages/cli/src/commands/daemon.ts` (not the leaf shape of `init.ts`), with a `check` subcommand calling the package (`loadPath` -> `assess` -> `summarize`/`toViolations` -> `formatReport`/`exitCodeFor`); register `.command(matterCommand)` in `packages/cli/src/cli.ts` (imports use `.js` extensions). The CLI's published dependency graph gains a transitive `@epicenter/field` (already publishable, not private).
- [ ] **1.6 Remove** Delete the old files from `apps/matter/src/lib/{core,load,report}` (now in the package); re-point or delete `apps/matter/src/cli/check.ts` and update the `check` script in `apps/matter/package.json`.
- [ ] **1.7 Prove** `epicenter matter check apps/matter/fixtures/check/pass` exits 0; a failing fixture exits non-zero; `--json` emits structured violations.

### Phase 2: The unified query engine

- [ ] **2.1** Generalize `mirror.svelte.ts`: `runQuery({ where?, match?, orderBy? })` returning ordered stems; `runSql(sql)` returning `{ columns, rows }`; the FTS `MATCH` join builder. Keep the `version` freshness gate.
- [ ] **2.2** Extend `projectToSqlite` (in `matter-core`) to add the `body` column and emit the FTS5 block when `searchable` is non-empty; add the top-level `searchable` policy to `contract.ts` (default = `body` + TEXT-storage fields).
- [ ] **2.3** Replace the grid's `WHERE`-only filter with a unified query state (`where` + `match` + `orderBy`). Run SQL only when a control is active; otherwise keep today's synchronous in-memory `view.conformance` (see The boundary). For active queries, build a `stem -> RowConformance` map and render in the SQL-returned order, skipping stems with no in-memory row (the mirror can briefly run ahead of memory). Cells still come from the in-memory map (`TableGrid.svelte:90-98`).

### Phase 3: The surfaces

- [ ] **3.1** Clickable column headers in `TableGrid.svelte:441-463` set `orderBy` (with an asc/desc indicator).
- [ ] **3.2** A "Search" box (distinct from the filter) sets `match`.
- [ ] **3.3** `SqlConsole.svelte`: CodeMirror SQL (dep `@codemirror/lang-sql`), Cmd+Enter -> `runSql`, results table, error line; "Edit as SQL" button seeds it from the grid's current query. Add a `VIEW_PARAM` to `routes.ts` and a render branch in `VaultShell.svelte:80-110` (grid vs console vs database), since today it renders `{#key activeTable}` the grid unconditionally; mount the console under `?view=sql`.
- [ ] **3.4** `DatabaseTab.svelte`: db path + per-table `CREATE TABLE` (export it from the projector) + a `sqlite3 <path>` line, all copyable. Mount under `?view=db` via the same `VIEW_PARAM` branch.

### Phase 4: Prove

- [ ] **4.1** `bun run typecheck` + `bun test` green across touched packages.
- [ ] **4.2** Manual smoke: open the sample vault (`bun run dev:fixture`), run a `JOIN` in the console, sort by a column, search a body word, copy the `sqlite3` line and confirm it opens the same db.

## Edge Cases

### Sort then edit the sorted column
1. Sort `books` by `rating`; edit a rating cell.
2. Value updates instantly (in-memory); position is stale until the next rebuild + requery.
3. Acceptable (see The boundary). Do not re-sort on every keystroke.

### FTS on untyped or invalid tables
1. An untyped folder (no `matter.json` fields) has no projected table.
2. No base table -> no FTS table -> search returns nothing for it.
3. Expected; search is a typed-table feature. Invalid rows still project (NULL/raw cells) and their bodies are still indexed.

### Console JOIN / aggregate results
1. User runs `SELECT author, count(*) FROM books GROUP BY author`.
2. Rows do not map to files.
3. Console renders them read-only; no edit affordance. By design.

### `searchable` empty or all-numeric
1. `searchable: []` or a folder with no text fields and `body` excluded.
2. No FTS block emitted; the search box is hidden or no-ops for that table.
3. Expected; default includes `body`, so this is rare.

## Open Questions

1. **Should an explicit `searchable` list be allowed to exclude `body`?**
   - The default is decided (Design Decisions): `body` + TEXT-storage fields. The only open part: may a folder whose bodies are noise drop `body` from its `searchable` list?
   - **Recommendation**: allow it. `searchable` is a free-form column list, so excluding `body` falls out with no special case.

2. **Sort: SQL `ORDER BY` (coherent, lags reposition) vs in-memory (instant reposition, second engine)?**
   - **Recommendation**: SQL `ORDER BY`, per The boundary. Revisit only if the reposition lag feels janky in the smoke test.

3. **In-vault view selection: a new `?view=` param vs a sentinel `?table=__sql__`?**
   - **Recommendation**: `?view=sql|db`, leaving `?table=` purely for table selection (`routes.ts:TABLE_PARAM`).

4. **Console export (CSV/JSON) in this launch?**
   - **Recommendation**: defer. The copyable `sqlite3` line and the console cover launch; add export if asked.

5. **Database tab: per-table or per-vault?**
   - **Recommendation**: per-vault panel that lists each table's `CREATE TABLE`, plus the single db path.

6. **The positioning/divergence ADR.** Resolved: [ADR-0059](../docs/adr/0059-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md) (`Proposed`) records it: Matter is a standalone, disk-as-truth tool; `matter.sqlite` is a read-only projection promoted to the headline query surface; the CLI is `epicenter matter`. It builds on ADR-0026 and is referenced from Design Decisions. Flip it to `Accepted` when the launch lands.

## Adjacent Work

- **`matter mcp` server (P1)**: reaches agent hosts without a shell (Claude Desktop, Cursor MCP, mobile). Four tools (`matter_tables`, `matter_query`, `matter_search`, `matter_write`) over the same `matter-core` + query engine. Not launch; the on-thesis launch story is "it is markdown and SQLite, your tools already work."
- **`epicenter matter query` / `add`**: build when MCP shares the core, or when a headless writer (e.g. the Plaid finance sync) needs validated `add`.
- **Palette + views**: `computed`/rollup fields, a kanban board view, `currency`/`duration`/`rating` kinds. Post-traction; the SQL console is the launch-time escape hatch that keeps the closed palette defensible.

## Decisions Log

- Keep the CLI namespaced under `epicenter` (`epicenter matter check`): collision-free and quarantines the disk-as-truth world from the daemon/Yjs verbs.
  Revisit when: Matter is distributed as a standalone product to non-Epicenter users, at which point ship a thin `matter` alias.

## Success Criteria

- [ ] A read-only SQL console runs arbitrary `SELECT`/`JOIN` against `matter.sqlite` and renders `{ columns, rows }`; writes are rejected.
- [ ] Clicking a column header sorts the grid; a search box matches row bodies; both flow through the one query builder.
- [ ] Per-folder FTS5 tables are built by the projector (no Rust change) and stay in sync across rebuilds.
- [ ] A "Database" panel shows the db path, each `CREATE TABLE`, and a copyable `sqlite3` line.
- [ ] `epicenter matter check <path>` ships in the binary, with `--json` and exit codes, backed by `@epicenter/matter-core`.
- [ ] `bun run typecheck` and `bun test` pass; old `apps/matter/src/lib/{core,load,report}` paths are deleted, not aliased.
- [x] A `Proposed` ADR records the standalone / disk-as-truth / `epicenter matter` decisions ([ADR-0059](../docs/adr/0059-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md)).

## References

- `apps/matter/src-tauri/src/mirror.rs:159` - `query_mirror` (arbitrary read-only SQL, returns `{ columns, rows }`)
- `apps/matter/src/lib/mirror.svelte.ts:84` - the canned `query()` to generalize; `:107` version gate
- `apps/matter/src/lib/core/sqlite.ts:112,152` - `buildDdl` / `projectToSqlite` (add body + FTS)
- `apps/matter/src/lib/core/contract.ts:79` - contract parser (add `searchable` policy, sibling of `optional`)
- `apps/matter/src/lib/where-filter.svelte.ts:38` - the `$effect` to fold into the unified query state
- `apps/matter/src/lib/components/TableGrid.svelte:90,441` - `filteredRows` (order-preserving); column headers (sort)
- `apps/matter/src/routes/(vaults)/vault/[id]/VaultShell.svelte:80` - in-vault tab bar (mount SQL/Database tabs)
- `apps/matter/src/cli/check.ts` - the CLI to move under `epicenter matter`
- `packages/cli/src/cli.ts` - register `matterCommand`
- `packages/workspace/src/document/materializer/sqlite/fts.ts` - external-content FTS5 pattern to port
- `docs/adr/0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md` - the truth-model constraint this launch preserves
