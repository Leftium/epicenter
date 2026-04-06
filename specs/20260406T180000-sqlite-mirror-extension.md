# SQLite Mirror Extension

**Date**: 2026-04-06
**Status**: Draft
**Author**: AI-assisted
**Related**: `docs/articles/sqlite-is-a-projection-not-a-database.md`

## Overview

A workspace extension that auto-materializes Yjs table data into SQLite for SQL queries, full-text search, and vector similarity search. Yjs stays the source of truth; SQLite is a derived, rebuildable read cache.

## Motivation

### Current State

Workspace persistence stores opaque Yjs binary updates—not queryable table data:

```typescript
// packages/workspace/src/extensions/persistence/sqlite.ts
db.run('CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)');
// INSERT INTO updates (data) VALUES (<Yjs binary blob>)
```

The only SQLite materialization that exists is the filesystem sqlite-index—a specialized, hardcoded extension for one table (`files`) with derived columns (`path`, `content`):

```typescript
// packages/filesystem/src/extensions/sqlite-index/index.ts
// - In-memory only (:memory:), rebuilt every page load
// - Hand-written Drizzle schema (duplicates workspace schema)
// - FTS5 for file content search
// - Not reusable for other tables
```

Application data access is all in-memory via Yjs:

```typescript
// apps/whispering — every table access pattern
workspace.tables.recordings.getAllValid()   // load all rows into memory
map.get(id)                                // lookup by ID
runs.filter(r => r.transformationId === id) // client-side JS filter
```

This creates problems:

1. **No SQL access**: Coding agents, MCP tools, and CLI commands can't query workspace data without understanding Yjs/CRDT internals. SQL is universal; the workspace API is not.
2. **No full-text search**: Searching recording transcriptions requires scanning every row in memory.
3. **No vector search**: Semantic similarity search over embeddings is impossible without SQLite vector columns.
4. **No portable export**: Users can't get a `.sqlite` file they can open in any SQL tool.
5. **No reusable pattern**: The filesystem sqlite-index is hardcoded to one table. Building equivalent functionality for Whispering's 5 tables means writing 5 separate extensions.

### Desired State

```typescript
// One line in client.ts — all workspace tables materialized to SQLite
export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    fts: {
      recordings: ['title', 'transcribedText'],
    },
  }));

// Agent/MCP: plain SQL
workspace.extensions.sqlite.client.execute(
  'SELECT * FROM recordings WHERE transcription_status = ? AND created_at > ?',
  ['DONE', '2026-03-30']
);

// FTS:
workspace.extensions.sqlite.search('recordings', 'meeting notes');
```

## Research Findings

### How Other Frameworks Handle This

| Framework | Schema Declaration | SQLite Role | FTS Approach |
|---|---|---|---|
| **PowerSync** | Manual JS schema, auto-generates SQLite tables via `powersync_replace_schema()` | Persistent materialization | FTS5 virtual tables + triggers (manual setup) |
| **ElectricSQL** | Manual local SQL tables, shape sync fills them | Persistent materialization | Postgres GIN indexes (manual SQL migrations) |
| **LiveStore** | Declare SQLite tables + event materializers | SQLite is the state store | Not built-in |
| **cr-sqlite** | Regular tables upgraded via `crsql_as_crr()` | SQLite IS the CRDT | FTS5 via extension |
| **Triplit** | Schema → KV store (not relational) | KV backend | None |
| **TinyBase** | In-memory store, SQLite = optional persistence | Persistence only | None |

**Key finding**: PowerSync's model is closest to what we need—manual schema declaration in code, auto-materialization into SQLite, FTS as a separate trigger-based layer. But we can go further: our workspace schemas already carry enough type information (via JSON Schema from `describeWorkspace()`) to auto-generate DDL without any manual schema declaration.

**Key finding**: No framework we surveyed auto-generates Drizzle ORM schemas from CRDT definitions. They either require manual SQL/schema declaration or use opaque KV storage. This validates our approach of generating raw DDL and keeping Drizzle as an optional, app-local concern.

### Turso/libSQL Vector Support

libSQL (Turso's SQLite fork) has native vector search—no extensions:

```sql
-- Vector column (1536-dim float32)
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  embedding F32_BLOB(1536)
);

-- DiskANN index (auto-maintained on INSERT/UPDATE/DELETE)
CREATE INDEX recordings_vec_idx ON recordings(libsql_vector_idx(embedding));

-- Query: top-k nearest neighbors
SELECT * FROM vector_top_k('recordings_vec_idx', vector32('[0.12, ...]'), 10)
JOIN recordings ON recordings.rowid = id;
```

Supported vector types: `F64_BLOB`, `F32_BLOB`, `F16_BLOB`, `FB16_BLOB`, `F8_BLOB`, `F1BIT_BLOB`. Distance functions: `vector_distance_cos`, `vector_distance_l2`.

### libSQL vs Vanilla SQLite: Platform Matrix

| Platform | Current SQLite | libSQL Option | Vector Support | FTS5 |
|---|---|---|---|---|
| **Browser** | `@libsql/client-wasm` (already used by filesystem) | Same | Unclear—DiskANN may be server-only in WASM builds | Yes |
| **Desktop (Tauri)** | `bun:sqlite` (vanilla) | `libsql` Rust crate via Tauri command | Yes (native) | Yes |
| **CLI (Bun)** | `bun:sqlite` (vanilla) | `@libsql/client` (Node/Bun native) | Yes | Yes |
| **Server** | `better-sqlite3` (dev dep) | `@libsql/client` | Yes | Yes |

**Key finding**: `@libsql/client-wasm` is already a dependency in `packages/filesystem`. Using libSQL everywhere gives us vector support on desktop/server. Browser vector support needs verification—WASM builds may not include the DiskANN index. FTS5 works everywhere regardless.

**Implication**: Use libSQL as the default SQLite driver. Fall back to vanilla SQLite only if libSQL WASM proves too large or missing vector support in browser. The mirror extension should accept an injected `Client` so the driver choice is the consumer's concern.

### Drizzle ORM: Needed or Not?

| Concern | Drizzle | Raw SQL |
|---|---|---|
| DDL generation (`CREATE TABLE`) | Requires hand-written schema | Generate from JSON Schema—simpler |
| INSERT/UPDATE/DELETE sync | `db.insert().values()` | Parameterized SQL—just as easy |
| FTS5 virtual tables | **Not supported** | Raw SQL (native) |
| Vector columns | **Not supported** | Raw SQL (native) |
| Typed SELECT queries | Real value—autocomplete, type safety | Returns `unknown[]` |
| Agent SQL queries | Agents write raw SQL regardless | Native |

**Key finding**: Drizzle adds no value for the mirror sync engine (DDL + INSERT/UPDATE/DELETE) and doesn't support FTS5 or vectors. Its only value is typed SELECT queries in TypeScript app code—a concern that belongs to the app, not the extension.

**Implication**: The extension core uses raw SQL only. Zero Drizzle dependency. Apps that want typed queries add Drizzle themselves with a hand-written schema against the mirrored tables.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| DDL generation | Auto-generate from workspace JSON Schema | Eliminates schema duplication. `describeWorkspace()` already produces JSON Schema per table. |
| SQL driver | Raw `@libsql/client` (injected) | No Drizzle in core. FTS5 and vectors require raw SQL anyway. Driver injection lets consumers choose WASM vs native. |
| FTS5 | Config option inside the extension | FTS triggers reference mirrored tables—same concern. Separate extension would need to reach into mirror internals. |
| Vectors | `onReady`/`onSync` lifecycle hooks | Vector columns and embeddings are app-specific (which columns, which model, what dimensions). Hooks give full control without baking AI concerns into the core. |
| Filesystem sqlite-index | Stays separate | It has derived columns (`path`, `content`), custom logic, in-memory storage. It's a specialized projection, not a generic mirror. |
| Drizzle typed queries | Opt-in, app-local | Apps declare a Drizzle schema locally only when they need typed SELECT queries. Not the extension's concern. |
| Storage mode | Injected client (caller decides `:memory:` vs file path) | Browser apps may want in-memory; CLI/desktop may want persistent. Extension doesn't decide. |
| Sync strategy | Observer-based with debounce | Match existing filesystem sqlite-index pattern. `table.observe()` → debounced batch upsert/delete. |
| `ctx.whenReady` | **Must await** before first sync | If SQLite materializes before Yjs persistence hydrates, we get partial data. The filesystem sqlite-index appears to skip this—we won't. |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Workspace (Yjs Y.Doc)                                          │
│                                                                 │
│  tables.recordings  ←→  Y.Array("table:recordings")            │
│  tables.transformations ←→ Y.Array("table:transformations")     │
│  kv.*               ←→  Y.Array("kv")                          │
│                                                                 │
│  Source of truth. All writes go here.                           │
└────────────┬──────────────────────────────────┬─────────────────┘
             │ table.observe() per table        │
             ▼                                  │
┌────────────────────────────────┐              │
│  createSqliteMirror()          │              │
│                                │              │
│  1. await ctx.whenReady        │              │
│  2. generateDDL(jsonSchema)    │              │
│     → CREATE TABLE per table   │              │
│  3. fullLoad: getAllValid()     │              │
│     → INSERT INTO ...          │              │
│  4. fts: CREATE VIRTUAL TABLE  │              │
│     + INSERT/UPDATE/DELETE      │              │
│     triggers                   │              │
│  5. onReady(db) hook           │              │
│  6. observe → debounced sync   │              │
│  7. onSync(db, changes) hook   │              │
│                                │              │
│  Exposes: { client, rebuild,   │              │
│    search? }                   │              │
└────────────┬───────────────────┘              │
             │                                  │
             ▼                                  │
┌────────────────────────────────┐              │
│  SQLite (libSQL)               │              │
│                                │              │
│  recordings     (auto DDL)     │              │
│  transformations (auto DDL)    │              │
│  recordings_fts (FTS5)         │              │
│  [vector cols]  (via onReady)  │              │
│  [custom indexes] (via onReady)│              │
└────────────────────────────────┘              │
                                                │
          ┌──── reads ────┐                     │
          ▼               ▼                     │
  ┌──────────────┐ ┌────────────┐  ┌───────────┴───────┐
  │ Coding Agent │ │ CLI tool   │  │ App code (writes) │
  │ (SQL)        │ │ (SQL)      │  │ (workspace API)   │
  └──────────────┘ └────────────┘  └───────────────────┘
```

### Write Flow

```
App code
  │
  ▼
workspace.tables.recordings.set(row)    ← writes to Yjs Y.Array
  │
  ▼
Y.Array fires observe callback
  │
  ▼
createSqliteMirror debounced sync
  │
  ▼
INSERT OR REPLACE INTO recordings ...   ← SQLite updated
  │
  ▼
FTS5 triggers fire automatically        ← FTS index updated
```

### JSON Schema → DDL Type Mapping

| JSON Schema | SQLite Type | Notes |
|---|---|---|
| `{ "type": "string" }` | `TEXT` | All strings, including branded IDs |
| `{ "type": "number" }` | `REAL` | Floats |
| `{ "type": "integer" }` | `INTEGER` | When JSON Schema has `"type": "integer"` |
| `{ "type": "boolean" }` | `INTEGER` | 0/1 |
| nullable (anyOf with null) | Column allows `NULL` | |
| `{ "type": "object" }` or `{ "type": "array" }` | `TEXT` | JSON-serialized |
| Union of string literals | `TEXT` | e.g., `'DONE' | 'PENDING'` → `TEXT` |
| `_v` field | `INTEGER NOT NULL` | Version discriminant, always present |
| `id` field | `TEXT PRIMARY KEY` | Always the primary key |

## API Design

```typescript
// ── Types ─────────────────────────────────────────────────────

type SqliteMirrorOptions = {
  /**
   * libSQL client instance. Caller chooses driver and storage mode.
   *
   * Browser: createClient({ url: ':memory:' }) from @libsql/client-wasm
   * Desktop: createClient({ url: 'file:///path/to/workspace.db' })
   * CLI:     createClient({ url: 'file:workspace.db' })
   */
  client: Client;

  /**
   * Which tables to mirror. Default: all workspace tables.
   * Use an array to mirror a subset.
   */
  tables?: 'all' | string[];

  /**
   * FTS5 full-text search configuration.
   * Map of table name → column names to index.
   *
   * Generates FTS5 virtual tables and INSERT/UPDATE/DELETE triggers.
   */
  fts?: Record<string, string[]>;

  /**
   * Called after mirror tables are created and initial data is loaded.
   * Use for: vector columns, custom indexes, views, additional tables.
   */
  onReady?: (db: Client) => void | Promise<void>;

  /**
   * Called after each sync cycle (batch of observer changes applied).
   * Use for: updating vector embeddings, custom derived columns.
   *
   * `changes` contains which tables had rows upserted or deleted.
   */
  onSync?: (db: Client, changes: SyncChange[]) => void | Promise<void>;

  /** Debounce interval (ms). @default 100 */
  debounceMs?: number;
};

type SyncChange = {
  table: string;
  upserted: string[];  // row IDs that were inserted or updated
  deleted: string[];    // row IDs that were deleted
};

// ── Extension return type ─────────────────────────────────────

type SqliteMirror = {
  /** Raw libSQL client for arbitrary SQL. */
  client: Client;

  /** Rebuild all mirrored tables from Yjs. Drops and recreates. */
  rebuild: () => Promise<void>;

  /**
   * FTS5 search helper. Only available if `fts` config was provided.
   * Returns rows with snippet highlights.
   */
  search: (table: string, query: string, options?: {
    limit?: number;
    snippetColumn?: string;
  }) => Promise<SearchResult[]>;
};

type SearchResult = {
  id: string;
  snippet: string;
  rank: number;
};
```

### Call-Site Examples

**Minimal (just mirror, no FTS):**

```typescript
import { createClient } from '@libsql/client-wasm';

export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    client: createClient({ url: ':memory:' }),
  }));
```

**With FTS:**

```typescript
export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    client: createClient({ url: ':memory:' }),
    fts: {
      recordings: ['title', 'transcribedText'],
      transformations: ['title', 'description'],
    },
  }));
```

**With vectors (desktop, via lifecycle hook):**

```typescript
export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    client: createClient({ url: 'file:workspace-mirror.db' }),
    fts: {
      recordings: ['title', 'transcribedText'],
    },
    async onReady(db) {
      await db.execute(
        'ALTER TABLE recordings ADD COLUMN IF NOT EXISTS embedding F32_BLOB(1536)'
      );
      await db.execute(
        'CREATE INDEX IF NOT EXISTS recordings_vec_idx ON recordings(libsql_vector_idx(embedding))'
      );
    },
    async onSync(db, changes) {
      // Re-embed changed recordings
      const recordingChanges = changes.find(c => c.table === 'recordings');
      if (!recordingChanges) return;
      for (const id of recordingChanges.upserted) {
        const row = await db.execute('SELECT transcribed_text FROM recordings WHERE id = ?', [id]);
        if (!row.rows[0]) continue;
        const embedding = await getEmbedding(row.rows[0].transcribed_text as string);
        await db.execute(
          'UPDATE recordings SET embedding = vector32(?) WHERE id = ?',
          [JSON.stringify(embedding), id]
        );
      }
    },
  }));
```

**With optional Drizzle typed queries (app-local):**

```typescript
// sqlite/schema.ts — hand-written, opt-in
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const recordings = sqliteTable('recordings', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  transcribedText: text('transcribed_text').notNull(),
  transcriptionStatus: text('transcription_status').notNull(),
  createdAt: text('created_at').notNull(),
});

// usage.ts
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './sqlite/schema';

const db = drizzle(workspace.extensions.sqlite.client, { schema });
const done = await db.select().from(schema.recordings)
  .where(eq(schema.recordings.transcriptionStatus, 'DONE'));
```

**MCP/Agent query surface:**

```typescript
// workspace action exposing SQL to agents
queryData: defineQuery({
  description: 'Run a read-only SQL query against workspace data',
  input: type({ sql: 'string' }),
  handler: ({ sql }) => {
    const result = workspace.extensions.sqlite.client.execute(sql);
    return { rows: result.rows, columns: result.columns };
  },
});
```

## Implementation Plan

### Phase 1: Core Mirror (no FTS, no vectors)

- [ ] **1.1** Create `packages/workspace/src/extensions/materializer/sqlite/` directory
- [ ] **1.2** Implement `generateDDL(tableDefinitions)`: walk `describeWorkspace()` JSON Schema per table → `CREATE TABLE IF NOT EXISTS` statements using the type mapping table above
- [ ] **1.3** Implement `createSqliteMirror(options)` extension factory:
  - Await `ctx.whenReady` before touching SQLite
  - Generate and execute DDL for each table
  - Full load: `table.getAllValid()` → batch `INSERT OR REPLACE INTO`
  - Return `{ client, rebuild }`
- [ ] **1.4** Implement observer-based incremental sync:
  - `table.observe()` per mirrored table
  - Debounced batch: collect changed IDs, then `INSERT OR REPLACE` for upserts, `DELETE` for removals
  - Call `onSync` hook after each batch
- [ ] **1.5** Implement `dispose()`: unsubscribe observers, close client if owned
- [ ] **1.6** Add tests: mirror creation, full load, incremental sync, rebuild

### Phase 2: FTS5

- [ ] **2.1** Implement FTS config parsing: `fts: { recordings: ['title', 'transcribedText'] }` → `CREATE VIRTUAL TABLE recordings_fts USING fts5(title, transcribedText, content=recordings, content_rowid=rowid)`
- [ ] **2.2** Generate INSERT/UPDATE/DELETE triggers to keep FTS in sync with mirror tables
- [ ] **2.3** Implement `search(table, query, options)` helper using FTS5 `MATCH` + `snippet()` + `rank`
- [ ] **2.4** Add tests: FTS creation, search, trigger-based sync after upsert/delete

### Phase 3: Lifecycle Hooks

- [ ] **3.1** Implement `onReady(db)` — called after DDL + full load + FTS setup
- [ ] **3.2** Implement `onSync(db, changes)` — called after each debounced sync batch with change details
- [ ] **3.3** Document hook patterns: vector columns, custom indexes, derived columns

### Phase 4: Integration

- [ ] **4.1** Wire into an app (opensidian or whispering) as proof of concept
- [ ] **4.2** Add MCP/agent query action using the mirror
- [ ] **4.3** Verify filesystem sqlite-index can coexist (separate extension, same workspace)

## Edge Cases

### Observer fires before persistence hydrates Yjs

1. Workspace created, SQLite mirror extension registered
2. Persistence extension starts loading Yjs updates from IndexedDB
3. Mirror extension starts observing—sees partial data

**Mitigation**: Mirror awaits `ctx.whenReady` before subscribing to observers. This ensures Yjs is fully hydrated before the first sync. The filesystem sqlite-index appears to skip this—we won't.

### Table schema changes (workspace version migration)

1. User updates app, workspace table gains a new column in `_v: 2`
2. SQLite mirror has the old schema (missing column)
3. Observer pushes rows with the new column

**Mitigation**: On startup, the mirror compares generated DDL against existing SQLite schema. If columns were added, run `ALTER TABLE ADD COLUMN`. If the schema change is more complex (column removed, type changed), drop and recreate the table. This is safe because SQLite is a rebuildable cache.

### Encrypted tables

1. Workspace uses `.withEncryption()` — table values in Yjs are ciphertext
2. Mirror calls `table.getAllValid()` — this returns decrypted rows (the table helper handles decryption)
3. SQLite would contain plaintext

**Consideration**: If the SQLite file is persistent (on-disk), it contains plaintext copies of encrypted workspace data. This may be acceptable (the user's local disk is already trusted) or may need SQLite-level encryption (SQLCipher, libSQL encryption). Left as an open question.

### Large tables

1. A table has 10,000+ rows
2. Full load on startup inserts all rows

**Mitigation**: Use `INSERT OR REPLACE` in transactions (batch 500 rows per transaction). The debounced observer handles incremental updates after the initial load, so startup is the only expensive operation.

### Concurrent observers (mirror + app code)

1. Mirror extension observes table changes
2. App code also observes the same table (e.g., SvelteMap reactive state)

**No issue**: Yjs supports multiple observers. Both fire independently.

## Open Questions

1. **libSQL WASM vector support**: Does `@libsql/client-wasm` include `F32_BLOB` columns and `libsql_vector_idx`? DiskANN may require native code not available in WASM. If not, vectors are desktop/server-only.
   - **Recommendation**: Verify by testing. If WASM lacks vectors, document it. FTS5 works everywhere regardless—that's the primary browser use case.

2. **Encrypted on-disk mirrors**: If the SQLite file is persistent and the workspace uses encryption, should we encrypt the SQLite file too?
   - Options: (a) Accept plaintext (local disk is trusted), (b) Use SQLCipher/libSQL encryption, (c) Only allow `:memory:` for encrypted workspaces
   - **Recommendation**: Accept plaintext for v1. The user's local filesystem is the same trust boundary as IndexedDB. Revisit if users request at-rest encryption for the mirror.

3. **Column name mapping**: Workspace schemas use camelCase (`transcribedText`). Should SQLite columns be snake_case (`transcribed_text`) or match the workspace?
   - Options: (a) Match workspace camelCase exactly, (b) Convert to snake_case for SQL convention
   - **Recommendation**: Match workspace names exactly. Agents and MCP tools will see the same names as the TypeScript API. No mapping confusion.

4. **KV store mirroring**: Should KV entries also be materialized to a SQLite table?
   - Options: (a) Tables only, (b) Also mirror KV as a `kv` table with `key TEXT PRIMARY KEY, value TEXT` columns
   - **Recommendation**: Tables only for v1. KV is settings/preferences—not useful for SQL queries or agent access.

5. **Should the extension own the client lifecycle?**: Currently the caller creates and passes the `Client`. Should the extension optionally accept a file path and create the client internally?
   - Options: (a) Always injected, (b) Accept `client` OR `filePath`, create client if path given
   - **Recommendation**: Support both. `filePath` is sugar for the common case; `client` gives full control.

## Success Criteria

- [ ] `createSqliteMirror({ client })` mirrors all workspace tables to SQLite with zero configuration
- [ ] DDL is auto-generated from workspace JSON Schema—no manual schema declaration required
- [ ] Incremental sync: Yjs table mutations appear in SQLite within `debounceMs`
- [ ] `fts` config generates working FTS5 virtual tables with trigger-based sync
- [ ] `search()` returns ranked results with snippet highlights
- [ ] `onReady` and `onSync` hooks fire at the right time with the right data
- [ ] Filesystem sqlite-index coexists as a separate extension on the same workspace
- [ ] No Drizzle dependency in the extension—raw SQL only
- [ ] Tests cover: full load, incremental upsert, incremental delete, FTS search, rebuild, schema migration

## References

- `packages/workspace/src/extensions/persistence/sqlite.ts` — Current Yjs binary persistence (NOT the mirror)
- `packages/workspace/src/extensions/materializer/markdown/` — Materializer extension pattern to follow
- `packages/filesystem/src/extensions/sqlite-index/` — Existing specialized sqlite-index (stays separate)
- `packages/filesystem/src/extensions/sqlite-index/ddl.ts` — DDL generation from Drizzle (reference for raw DDL approach)
- `packages/filesystem/src/extensions/sqlite-index/schema.ts` — Hand-written Drizzle schema (what we're replacing with auto-generation)
- `packages/workspace/src/workspace/describe-workspace.ts` — JSON Schema output for workspace introspection
- `packages/workspace/src/workspace/types.ts` — `BaseRow`, `TableDefinition`, extension types
- `packages/workspace/src/workspace/create-workspace.ts` — Extension registration and `ctx.whenReady`
- `docs/articles/sqlite-is-a-projection-not-a-database.md` — Conceptual article explaining the architecture
