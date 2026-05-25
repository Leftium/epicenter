# SQLite FTS Primitive Split

**Date**: 2026-05-25
**Status**: Implemented (Option A′)
**Owner**: Braden
**Branch**: braden-w/pull-origin-main

## One Sentence

Keep the single attach call and the keyed `fts: {...}` option, but move the FTS surface (`search`, plus future `optimize`/`rebuild`) onto a nested `sqlite.fts` namespace whose type-level presence is conditional on whether the caller passed `fts`; lift FTS setup, triggers, and the search action into a private internal FTS layer inside `materializer/sqlite/`.

## Update (post-grilling)

The earlier draft recommended Option C (inline public, split internal) and considered Option B (public `attachFts(sqlite, ...)`) as a rejected alternative. After grilling, the chosen direction is **Option A′** below: same single-attach lifecycle and structural single-attach invariant as Option A, plus the honest namespace Option B offered, without the runtime guard, backfill, or extra barrier B carried. The earlier sections (Option A, Option B, Option C) are kept for context but are no longer the recommendation.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  Mental Model
  Recommendation

Read if weighing the alternative:
  Option A / Option B / Option C
  Type Inference Probe
  Design Decisions

Read if implementing:
  Implementation Plan
  Verification
```

## Overview

FTS5 setup, triggers, search SQL, and the `search()` action live inline inside `attachSqliteMaterializerCore`. A near-duplicate FTS search implementation lives in `openSqliteReader`. The question: should FTS become its own public `attachFts(sqlite, config)` primitive, or stay inline on the materializer? This spec recommends a third path: keep the inline public API, split the internal layer.

## Current State

### Public API (today on this branch)

```ts
const tables = attachTables(ydoc, tableDefinitions);

const sqlite = attachBunSqliteMaterializer(ydoc, {
  filePath: sqlitePath(projectDir, ydoc.guid),
  tables,
  fts: { posts: ['title', 'body'] },
});

const hits = await sqlite.search({ table: 'posts', query: 'hello' });
```

### Where FTS lives

```txt
packages/workspace/src/document/materializer/sqlite/
  core.ts         attachSqliteMaterializerCore, ftsColumns stored per RegisteredTable
                  initialize() calls setupFtsTable inline
                  search() method dispatches to ftsSearch
  fts.ts          setupFtsTable (DDL + 3 triggers), ftsSearch (query + snippet SQL)
  bun-sqlite.ts   forwards { tables, fts } to core
  turso.ts        forwards { tables, fts } to core
  index.ts        re-exports SearchOptions, SearchResult

packages/workspace/src/document/
  open-sqlite-reader.ts   duplicates the FTS search SQL (no shared helper)
                          discovers fts columns via PRAGMA table_info instead
```

### What FTS depends on

| Dependency | Why FTS needs it |
| --- | --- |
| `MirrorDatabase` (SQL executor) | DDL for the virtual table, triggers, and search query. |
| Source table name | Triggers reference `<table>` and write to `<table>_fts`. |
| Source row column names | Trigger column list and snippet column index. |
| Registered table row type | Type-level: `FtsConfig<TTables>` narrows column keys per table. |
| Initial-flush ordering | FTS virtual table + triggers must exist before the full-load INSERT loop so the triggers populate the FTS index automatically. |

FTS does **not** depend on:

- The Y.Doc observer pipeline. The triggers fire on the SQLite side; FTS knows nothing about Yjs.
- The debounced sync queue. Once the source row lands via UPSERT/DELETE, the trigger updates FTS in the same transaction.
- The `RegisteredTable.unsubscribe` slot. FTS has no observers of its own.

### Implementation note: trigger-driven population

`initialize()` runs in this order:

```txt
await waitFor

for each table:
  db.run(generateDdl)        // CREATE TABLE
  setupFtsTable(...)          // CREATE VIRTUAL TABLE + 3 triggers

BEGIN
for each table:
  fullLoadTable               // INSERT ... ON CONFLICT DO UPDATE
                              // triggers populate <table>_fts as rows land
COMMIT

for each table:
  table.observe(...)          // attach Yjs observer
```

This ordering is load-bearing for the "set up FTS first, then bulk insert" property. Any split must preserve it or accept a follow-up backfill.

## Mental Model

```txt
Y.Doc table materialization (mirroring):

  Y.Doc tables (Y.Map of rows)
    -> observer / debounced flush
      -> SQLite real tables  ─────── owned by core


FTS indexing (derived, secondary):

  SQLite real tables
    -> AFTER INSERT/UPDATE/DELETE triggers
      -> SQLite <table>_fts virtual tables
        -> search() SQL surface  ─── owned by fts.ts (no Yjs awareness)
```

FTS is a secondary, derived index over the materialized SQLite tables. It is coupled to SQLite (uses FTS5, triggers, the same `MirrorDatabase` handle) but it is **not** coupled to the Yjs-side mirroring. That gap is the boundary the split should follow.

## Option A: Keep FTS Inline (status quo)

```ts
attachBunSqliteMaterializer(ydoc, {
  filePath,
  tables,
  fts: { posts: ['title', 'body'] },
});
```

| Pros | Cons |
| --- | --- |
| One call, one barrier (`whenFlushed`), one disposal. | `core.ts` carries FTS branches inside `initialize`, `search`, the `RegisteredTable` struct. |
| FTS table created **before** full-load: triggers populate it for free, no backfill pass. | `open-sqlite-reader.ts` duplicates the FTS search SQL because no shared helper exists. |
| `FtsConfig<TTables>` narrows from the same `tables` generic; no extra factory plumbing. | `search()` accepts any string; no compile-time narrowing to FTS-enabled tables. |
| Matches the existing markdown shape (`perTable`). | Adding FTS-specific surface (`rebuild()`, tokenizer config) means widening core options. |

## Option B: Split FTS Into `attachFts`

```ts
const sqlite = attachBunSqliteMaterializer(ydoc, { filePath, tables });

const fts = attachFts(sqlite, {
  posts: ['title', 'body'],
});

const hits = await fts.search('posts', 'query');
```

| Pros | Cons |
| --- | --- |
| FTS becomes a self-contained primitive: own setup, own search, own potential `rebuild()` / `optimize()` / tokenizer config. | Two call sites, two barriers. Caller must `await sqlite.whenFlushed` then run a backfill pass through FTS because triggers were not present during the initial bulk insert. |
| `search()` can narrow `table` to `keyof TFts` for autocomplete and typo errors. | Adds a public surface that ~5 call sites currently set with one line. Net surface grows. |
| Naturally extends to "multiple search indexes" (different column sets, different tokenizers) by attaching twice. | `attachFts` needs to read `TTables` off the materializer return type so columns narrow per row. Requires propagating the `TTables` generic through `attachBunSqliteMaterializer<TTables>` / `attachTursoMaterializer<TTables>` results, which the current code does not preserve. |
| Models FTS-on-Turso symmetrically with FTS-on-bun-sqlite. | Backfill on attach (run `INSERT INTO <fts>(rowid, ...) SELECT rowid, ... FROM <table>`) is the right way to handle "FTS attached late", but that is new code, new failure modes, and new tests. |
| | Lifecycle: the materializer can flush again after FTS attaches; FTS triggers handle it. But the initial backfill window is racy if the caller writes rows between `whenFlushed` and `attachFts(...)`. Easiest fix is to attach FTS synchronously after the materializer, before any external writes, which is exactly the inline contract by another name. |

## Option C: Inline Public API, Split Internal Layer (recommended)

The public API stays as today. Inside the package, FTS becomes its own attach primitive that lives next to the materializer core but is composed by it.

```ts
// Public (unchanged)
const sqlite = attachBunSqliteMaterializer(ydoc, {
  filePath,
  tables,
  fts: { posts: ['title', 'body'] },
});
await sqlite.whenFlushed;
await sqlite.search({ table: 'posts', query: 'hello' });
```

Internal composition:

```ts
// packages/workspace/src/document/materializer/sqlite/core.ts
export function attachSqliteMaterializerCore<TTables extends TablesRecord>(
  ydoc: Y.Doc,
  { db, tables, fts, debounceMs, waitFor, log }: ...,
) {
  // core no longer holds ftsColumns or knows what FTS is
  const registered = new Map<string, { table: AnyTable; unsubscribe?: () => void }>();
  // ... full-load + observe loop, with one explicit hook ...

  // The core exposes a structural "after DDL, before bulk insert" hook so the
  // FTS layer can plant its virtual table and triggers in the right slot.
  // The hook is module-private; nothing leaks externally.
  const ftsLayer = fts
    ? attachSqliteFts({ db, tables, fts, log })
    : undefined;

  // initialize:
  //   await waitFor
  //   for each table: db.run(ddl)
  //   ftsLayer?.beforeFullLoad()   // CREATE VIRTUAL TABLE + triggers
  //   BEGIN ... fullLoadTable ... COMMIT
  //   attach observers

  return {
    whenFlushed,
    search: ftsLayer?.search ?? noopSearch,
    count: ...,
    rebuild: ...,
  };
}
```

```ts
// packages/workspace/src/document/materializer/sqlite/fts.ts
export function attachSqliteFts<TTables extends TablesRecord>({
  db,
  tables,
  fts,
  log,
}: {
  db: MirrorDatabase;
  tables: TTables;
  fts: FtsConfig<TTables>;
  log: Logger;
}) {
  const ftsColumns = new Map<string, string[]>();
  for (const [name, cols] of Object.entries(fts)) {
    if (cols && cols.length > 0) ftsColumns.set(name, cols as string[]);
  }

  async function beforeFullLoad() {
    for (const [name, cols] of ftsColumns) await setupFtsTable(db, name, cols);
  }

  const search = defineQuery({
    title: 'Full-text search',
    input: Type.Object({ table: Type.String(), query: Type.String(), limit: Type.Optional(Type.Number()) }),
    handler: ({ table, query, limit }) => {
      const cols = ftsColumns.get(table);
      if (!cols) return Promise.resolve([]);
      return ftsSearch(db, table, cols, query, limit !== undefined ? { limit } : undefined, log);
    },
  });

  return { beforeFullLoad, search };
}
```

What this buys:

| Win | How |
| --- | --- |
| Core stays focused on Y.Doc -> SQLite mirroring. | FTS columns, `setupFtsTable` calls, search SQL, and the FTS error type leave `core.ts`. |
| Public API unchanged. | `fts: {...}` still narrows from `tables`, still feeds the same path. |
| `openSqliteReader` can reuse the search query builder. | Extract `buildFtsSearchSql(table, cols, snippetColumn)` from `ftsSearch` and share it between `attachSqliteFts` (writer side) and `openSqliteReader` (reader side). The reader still discovers `cols` via PRAGMA. |
| Forward-compatible with later public split. | If someone wants `rebuild()` / `optimize()` / tokenizer config later, the internal boundary is already there. Promoting `attachSqliteFts` to public is a rename and one option-bag forwarding edit. |
| No new lifecycle barriers. | `beforeFullLoad()` runs inside `initialize()` at the existing DDL slot. No `whenFtsReady` promise. |

Trade-offs:

| Cost | Note |
| --- | --- |
| One more internal file edge (`core` calls into `fts` at a named slot). | Worth it: that slot is already where the inline `setupFtsTable` call lives. |
| `search` becomes a no-op when `fts` is undefined. | Already true today (`if (ftsColumns === undefined) return []`). Move the conditional from inside the handler to the assembly site. |
| No public type narrowing on `search({ table })`. | Same as today. The action handlers are TypeBox-validated at runtime; tightening the input shape is orthogonal to this split. |

## Type Inference Probe

The proposed inline `FtsConfig<TTables>` shape is already on this branch and verified in `specs/20260525T134351-materializer-tables-as-record.md` (see the table at line 142-151). For the split (Option B) the relevant question is whether `attachFts(sqlite, ...)` can preserve the same narrowing.

Sketch (not committed):

```ts
type MaterializerWithTables<TTables extends TablesRecord> = {
  __tables: TTables;                       // phantom or actual field
  db: MirrorDatabase;
  whenFlushed: Promise<void>;
  // ...
};

function attachFts<TTables extends TablesRecord>(
  sqlite: MaterializerWithTables<TTables>,
  config: FtsConfig<TTables>,
): { search: <K extends keyof FtsConfig<TTables>>(table: K, query: string) => Promise<SearchResult[]> };
```

| Probe | Result expected |
| --- | --- |
| `attachFts(sqlite, { posts: ['title'] })` with valid keys | compiles |
| `attachFts(sqlite, { typo: [...] })` | key error |
| `attachFts(sqlite, { posts: ['badColumn'] })` | value error |
| `fts.search('posts', 'q')` | compiles |
| `fts.search('notes', 'q')` when notes not in FTS config | possible to narrow with a second generic `TFts`, but only if `attachFts` returns the literal config keys, not `keyof TTables` |

The narrowing `search` to FTS-enabled tables only is the one type-level win Option B can claim that Option C cannot. It costs:

- A new generic threaded through `attachBunSqliteMaterializer<TTables>` -> result -> `attachFts<TTables, TFts>` -> result.
- A phantom `__tables` field or equivalent on the materializer return, so `attachFts` can read `TTables` off it.

This is implementable. It is not free.

For Option C, no probe is needed: the public types are unchanged from the current branch.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Public API shape | 2 coherence | Keep `fts` inline on the materializer options. | Matches the markdown materializer's `perTable` shape. The 80% case (`fts: { posts: ['title'] }`) stays one line. |
| Internal boundary | 1 evidence | Extract `attachSqliteFts(core-like deps)` inside `materializer/sqlite/`. | `setupFtsTable`, `ftsSearch`, and `FtsError` already live in `fts.ts`. The remaining state (FTS columns map, search action) is small and self-contained. |
| Search return surface | 3 taste | Keep `defineQuery` action with `table: string` input. | Tightening to `keyof TFts` requires the Option B generic-threading; not justified for current call sites (one repo-wide `materializer.search(...)` site in `apps/opensidian`). |
| Migration path | 2 coherence | Internal-only change. No public migration. | Zero call-site churn. Future promotion to public `attachFts` stays open. |
| Trigger-driven population | 1 evidence | Preserve "FTS DDL before full-load" ordering. | Verified in `core.ts:329-361`. Splitting this order would force a backfill `INSERT INTO <fts> SELECT ...` pass, which is more code and more failure modes. |
| Code sharing with reader | 1 evidence | Extract `buildFtsSearchSql` helper shared with `openSqliteReader`. | The two SQL strings in `fts.ts:181-191` and `open-sqlite-reader.ts:131-142` are identical modulo formatting. |

## Option A′: Single Attach, Nested `sqlite.fts` Namespace (recommended)

```ts
const sqlite = attachBunSqliteMaterializer(ydoc, {
  filePath,
  tables,
  fts: { posts: ['title', 'body'] },
});

await sqlite.whenFlushed;
sqlite.fts.search({ table: 'posts', query: 'hello' });
```

When the caller omits `fts`, `sqlite.fts` is absent from the return type. The conditional return type does the narrowing:

```ts
type Result<TTables, TFts> =
  & { whenFlushed: Promise<void>; client: Database; count: ...; rebuild: ... }
  & (TFts extends FtsConfig<TTables> ? { fts: FtsSurface<TTables, TFts> } : {});
```

What A′ gives us:

| Win | How |
| --- | --- |
| Single attach, structural single-attach invariant. | Can't call twice; only one `fts` slot per call. |
| One barrier (`whenFlushed`), one DDL ordering window. | Triggers populate `_fts` during the existing full-load; no backfill SQL. |
| Honest namespace. | `sqlite.search` no longer exists. FTS methods live on `sqlite.fts`. |
| Type-level honesty. | `sqlite.fts` is absent in the type when no FTS was configured. |
| Core stays focused on Y.Doc → SQLite mirroring. | `RegisteredTable.ftsColumns` leaves the struct; `setupFtsTable` / `ftsSearch` are reached through an internal `createSqliteFtsLayer({ db, fts, log })` factory. |
| Future FTS features land cleanly. | `sqlite.fts.optimize()` / `sqlite.fts.rebuild()` / tokenizer config grow on the FTS layer, not the materializer's top level. |

What A′ rejects from Option B (public split):

- No second `attachFts(sqlite, ...)` export.
- No `whenIndexed` barrier (single `whenFlushed`).
- No backfill SQL (triggers already populate `_fts` during full-load).
- No race window between materializer flush and FTS attach.
- No WeakSet guard for double-attach.

The only case Option B would still win is **multiple named FTS indexes per source table** (e.g., `posts_fts_title` and `posts_fts_full` on the same `posts`). Out of scope for V1; revisit when a concrete need appears.

## Recommendation

**Option A′: keep the single attach with the keyed `fts` slot; move the FTS surface onto a nested, conditionally-present `sqlite.fts` namespace; lift FTS internals into `createSqliteFtsLayer` inside `fts.ts`.**

Argument for: structural single-attach invariant, single DDL/full-load window, honest namespace, type-level presence, no migration churn for non-FTS callers, no backfill or extra barrier. The boundary between Y.Doc→SQLite and SQLite→FTS5 is enforced internally; the public surface is one option key (unchanged from the parent spec) and one namespace (`sqlite.fts.search`).

Argument against: requires a conditional return type (`TFts extends FtsConfig<TTables> ? {...} : {}`), which is one more piece of type-level cleverness in the materializer signature. Mitigation: well-localised inside the two backend factories; nothing outside `materializer/sqlite/` needs to read it.

## Implementation Plan (A′)

### Phase 1: Internal extraction and namespace move

- [ ] **1.1** `core.ts`: drop `ftsColumns` from `RegisteredTable`. Struct collapses to `{ table, unsubscribe? }`.
- [ ] **1.2** `fts.ts`: add `createSqliteFtsLayer({ db, fts, log })` that owns the FTS column map, the `beforeFullLoad()` DDL/trigger pass, and the `search` action. `@internal`.
- [ ] **1.3** `core.ts`: build the FTS layer iff `fts` is defined. Call `ftsLayer?.beforeFullLoad()` between table DDL and `BEGIN`. Return `{ whenFlushed, count, rebuild, ...(ftsLayer ? { fts: { search: ftsLayer.search } } : {}) }`.
- [ ] **1.4** `core.ts`: thread `TFts` generic with default `undefined`. The signature reads `<TTables, TFts extends FtsConfig<TTables> | undefined = undefined>` so the return narrows.
- [ ] **1.5** `bun-sqlite.ts` / `turso.ts`: propagate `TFts` generic, return `{ ...core, client }` (Bun) / `{ ...core, whenConnected, client }` (Turso). `fts` namespace flows through `...core`.

### Phase 2: Test and call-site updates

- [ ] **2.1** `core.test.ts`: change every `sqlite.search({...})` to `sqlite.fts.search({...})`. The "no fts configured" test asserts `sqlite.fts` is `undefined` instead of `sqlite.search` returning `[]`.
- [ ] **2.2** `core.test.ts` action-brand block: assert `isAction(sqlite.fts.search)` (only when FTS configured).
- [ ] **2.3** `playground/opensidian-e2e/workspaces/opensidian/daemon.ts`: no change to the call site itself (it doesn't call `.search`), but the return type narrows.

### Phase 3: Verification

- [ ] **3.1** `cd packages/workspace && bun run typecheck`
- [ ] **3.2** `cd packages/workspace && bun test`
- [ ] **3.3** `rg "ftsColumns" packages/workspace/src/document/materializer/sqlite/core.ts` → zero hits.
- [ ] **3.4** `rg "setupFtsTable|ftsSearch" packages/workspace/src/document/materializer/sqlite/core.ts` → zero hits.

### Phase 4: Doc sweep

- [ ] **4.1** `packages/workspace/README.md` SQLite example: align with `attachBunSqliteMaterializer({ filePath, tables, fts })` and `sqlite.fts.search({...})`. (Existing example was already stale on the parent refactor; fixing in this pass.)
- [ ] **4.2** `.agents/skills/attach-primitive/SKILL.md`: keep the `fts: {...}` option example unchanged; add one line near the materializer example noting the result surface (`sqlite.fts.search(...)`).
- [ ] **4.3** `createSqliteFtsLayer` carries an `@internal` JSDoc tag.

### Phase 5 (deferred): reader dedup

The `openSqliteReader` ↔ materializer search-SQL duplication is real but orthogonal to A′. Bundle later when a third caller appears or when tokenizer config forces a shared `buildFtsSearchSql({ table, ftsColumns, snippetColumn })`.

## Rejected Alternatives

| Candidate | Why rejected |
| --- | --- |
| Public `attachFts(sqlite, config)` (Option B) | Forces a backfill pass or a fragile "attach FTS before any writes" contract. Threads a new `TTables` generic through the materializer return type just to recover the narrowing the inline form gets for free. The public surface grows for marginal type-level gain. |
| Chained `.withFts({ posts: ['title'] })` | Re-introduces per-backend factory rebinding (the same problem the recent `tables`-as-record refactor removed; see `specs/20260525T134351-materializer-tables-as-record.md`). No inference benefit over the keyed object. |
| Per-table tuple config (`tables: [[ref, { fts: [...] }]]`) | Attempted and reverted on this branch (commit `0b90d7158` -> `f4a79a28e`). Variadic mapped-type inference is brittle and the double-bracket call shape regresses the single-table case. |
| Caller manages the virtual table directly | Pushes SQLite FTS5 DDL and trigger management into every app. Defeats the point of the materializer primitive. |
| Promote `attachSqliteFts` straight to public now | Possible later. Doing it now would change the public API on a branch whose stated direction (the inline `fts` slot) just landed. |

## Verification

```bash
cd packages/workspace && bun run typecheck
cd packages/workspace && bun test

# Confirm core no longer mentions FTS internals
rg "ftsColumns|setupFtsTable|ftsSearch" packages/workspace/src/document/materializer/sqlite/core.ts

# Confirm the shared SQL builder is wired into both sides
rg "buildFtsSearchSql" packages/workspace/src/document/

# Repo-wide sanity check: public surface untouched
rg "fts:\s*\{" apps/ examples/ playground/
```

## Open Questions

1. **Is the reader-dedup phase worth bundling with the materializer split?**
   - Options: (a) bundle, (b) split into a follow-up.
   - **Recommendation**: bundle. The duplication is the single strongest evidence that an internal FTS module earns its keep.

2. **Should the `search` action remain a `defineQuery` no-op when `fts` is undefined, or should the property be absent from the return type?**
   - Options: (a) always present, no-op when unconfigured (today's behavior), (b) `search` is conditionally typed and absent when `fts` is omitted.
   - **Recommendation**: keep (a). Conditional return types complicate the consumer (`materializer.search?.(...)` everywhere). The no-op path is one line.
