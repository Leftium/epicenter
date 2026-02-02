# Dual-Provider Architecture: Turso WASM + SQLite

**Created**: 2026-01-08T05:30:00
**Status**: Architecture Decided, Ready for Implementation
**App**: Epicenter (Tauri + Svelte 5)

## Goal

Create two Epicenter providers that materialize YJS data:

1. **turso**: In-memory WASM database with vector support for fast semantic search
2. **sqlite**: Filesystem-persisted database via Tauri plugin for external tool access

## Requirements

1. **Local-first**: All data stays on device, no cloud dependency
2. **In-memory performance**: Fast vector queries without disk I/O latency (turso)
3. **Filesystem persistence**: Standard `.db` file accessible by external tools (sqlite)
4. **No HTTP for IPC**: Security concern - other processes can access localhost endpoints
5. **Vector support**: Native F32_BLOB columns, similarity search, indexing (turso only)

## Critical Research Findings

### Turso WASM Vector Support: CONFIRMED

The `@tursodatabase/database-wasm` package includes **full native vector support**:

```sql
-- Vector column definition
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  transcript TEXT,
  embedding F32_BLOB(1536)  -- 1536-dimensional for OpenAI embeddings
);


-- Create DiskANN vector index
CREATE INDEX recordings_vec_idx ON recordings (
  libsql_vector_idx(embedding, 'compress_neighbors=float8', 'max_neighbors=20')
);

-- Insert with vector conversion
INSERT INTO recordings (id, transcript, embedding)
VALUES ('rec1', 'Hello world', vector32('[0.1, 0.2, ...]'));

-- Approximate nearest neighbor search
SELECT id, transcript
FROM vector_top_k('recordings_vec_idx', vector32('[0.5, 0.5, ...]'), 10) AS top
JOIN recordings ON recordings.rowid = top.id;

-- Exact search with distance
SELECT id, transcript,
       vector_distance_cos(embedding, vector32('[0.5, ...]')) AS distance
FROM recordings
ORDER BY distance ASC
LIMIT 10;
```

**Vector types available**: F32_BLOB (recommended), F64_BLOB, F16_BLOB, F8_BLOB, F1BIT_BLOB
**Distance metrics**: cosine (default), l2
**Max dimensions**: 65,536

### Turso WASM Serialization: NOT AVAILABLE

**This is a critical constraint that changes the architecture.**

The Turso WASM package does **NOT** expose `sqlite3_js_db_export()` or `sqlite3_deserialize()` APIs:

- TypeScript definitions only expose: `connect()`, `Database`, `prepare()`, `exec()`, `close()`
- No export/serialize methods are defined
- Persistence uses OPFS (Origin Private File System) - browser sandbox only
- OPFS files are **not accessible** from the regular filesystem

This means we **cannot** directly export the database to a `.db` file that external tools can read.

### Official SQLite WASM Serialization: AVAILABLE

The official SQLite WASM (not Turso) **does** expose serialization:

```typescript
// Export database to bytes
const byteArray = sqlite3.capi.sqlite3_js_db_export(db.pointer);

// Restore from bytes
const bytes = new Uint8Array(arrayBuffer);
const p = sqlite3.wasm.allocFromTypedArray(bytes);
const db = new sqlite3.oo1.DB();
sqlite3.capi.sqlite3_deserialize(
	db.pointer,
	'main',
	p,
	bytes.length,
	bytes.length,
	sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
);
```

**However**: Official SQLite WASM does NOT have native vector support. You would need to statically compile sqlite-vec into the WASM build (extensions cannot be dynamically loaded in WASM).

### Tauri Configuration: VERIFIED

COOP/COEP headers for SharedArrayBuffer support in `tauri.conf.json`:

```json
{
	"app": {
		"security": {
			"headers": {
				"Cross-Origin-Opener-Policy": "same-origin",
				"Cross-Origin-Embedder-Policy": "require-corp"
			}
		}
	}
}
```

Binary data transfer via IPC:

- Rust `Vec<u8>` automatically converts to `Uint8Array` on frontend
- Use `app.path().resolve("file.db", BaseDirectory::AppData)` for paths

## Final Architecture: Dual-Provider System

Two independent providers that both materialize YJS data with debounced rebuilds:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              YJS Document                                    │
│                         (Source of Truth)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│      turso Provider             │   │      sqlite Provider            │
│  ┌───────────────────────────┐  │   │  ┌───────────────────────────┐  │
│  │ @tursodatabase/database-  │  │   │  │ tauri-plugin-sql          │  │
│  │ wasm                      │  │   │  │ (vanilla SQLite)          │  │
│  │                           │  │   │  │                           │  │
│  │ - In-memory (:memory:)    │  │   │  │ - Filesystem .db file     │  │
│  │ - F32_BLOB vector columns │  │   │  │ - No vector support       │  │
│  │ - vector_top_k() search   │  │   │  │ - External tool access    │  │
│  │ - DiskANN indexing        │  │   │  │ - Standard SQLite format  │  │
│  │ - NO filesystem persist   │  │   │  │                           │  │
│  └───────────────────────────┘  │   │  └───────────────────────────┘  │
│                                 │   │               │                 │
│  [WebView - WASM]               │   │  ~/.local/share/com.epicenter/  │
└─────────────────────────────────┘   │           └── workspace.db      │
                                      └─────────────────────────────────┘
```

### Provider Comparison

| Aspect               | `turso` Provider               | `sqlite` Provider                 |
| -------------------- | ------------------------------ | --------------------------------- |
| **Location**         | WebView (WASM)                 | Tauri backend (native)            |
| **Storage**          | In-memory (`:memory:`)         | Filesystem `.db` file             |
| **Vector Support**   | Yes (F32_BLOB, vector_top_k)   | No (vanilla SQLite)               |
| **External Access**  | No                             | Yes (sqlite3 CLI, Obsidian, etc.) |
| **Package**          | `@tursodatabase/database-wasm` | `tauri-plugin-sql`                |
| **Rebuild Strategy** | Close + reinitialize           | Drop tables + recreate            |

### Rebuild Strategy Decision

For **turso** (in-memory): **Close and reinitialize** is recommended.

```typescript
// Turso: Close and reinitialize (simpler, equally fast for :memory:)
async function rebuildTurso() {
	db.close();
	db = await connect({ url: ':memory:' });
	await recreateTables();
	await insertAllRowsFromYJS();
}
```

For **sqlite** (filesystem): **Drop tables and recreate** (matches existing sqlite.ts pattern).

```typescript
// SQLite: Drop and recreate (preserves file handle)
async function rebuildSqlite() {
	for (const table of tables) {
		await db.execute(`DROP TABLE IF EXISTS "${table}"`);
	}
	await recreateTables();
	await insertAllRowsFromYJS();
}
```

## Implementation Plan

### Phase 1: Create Provider Structure

Location: `apps/epicenter/src/lib/providers/`

```
apps/epicenter/src/lib/providers/
├── turso.ts          # In-memory WASM with vector support
├── sqlite.ts         # Filesystem persistence via Tauri plugin
└── index.ts          # Re-exports
```

### Phase 2: Turso Provider

**File**: `apps/epicenter/src/lib/providers/turso.ts`

```typescript
import { connect, type Database } from '@tursodatabase/database-wasm/vite';
import { defineCapabilities, type CapabilityContext } from '@epicenter/hq';

const DEFAULT_DEBOUNCE_MS = 100;

export type TursoConfig = {
	/** Debounce interval in milliseconds. @default 100 */
	debounceMs?: number;
};

export const turso = async <TTablesSchema extends TablesSchema>(
	{ id, tables }: CapabilityContext<TTablesSchema>,
	config: TursoConfig = {},
) => {
	const { debounceMs = DEFAULT_DEBOUNCE_MS } = config;

	// Initialize in-memory database
	let db = await connect({ url: ':memory:' });

	// Convert workspace schema to SQL DDL
	const drizzleTables = convertWorkspaceSchemaToDrizzle(schema);

	// Create tables with vector columns where applicable
	await recreateTables(db, drizzleTables);

	// Debounce state
	let syncTimeout: ReturnType<typeof setTimeout> | null = null;

	async function rebuild() {
		db.close();
		db = await connect({ url: ':memory:' });
		await recreateTables(db, drizzleTables);
		// Insert all valid rows from YJS
		for (const table of tables.defined()) {
			const rows = table.getAllValid();
			// Insert with vector conversion for embedding columns
			// ...
		}
	}

	function scheduleSync() {
		if (syncTimeout) clearTimeout(syncTimeout);
		syncTimeout = setTimeout(rebuild, debounceMs);
	}

	// Set up observers for each table
	const unsubscribers = tables
		.defined()
		.map((table) => table.observeChanges(() => scheduleSync()));

	// Initial sync
	await rebuild();

	return defineCapabilities({
		async destroy() {
			if (syncTimeout) clearTimeout(syncTimeout);
			unsubscribers.forEach((unsub) => unsub());
			db.close();
		},

		/** Semantic search using vector similarity */
		async vectorSearch(embedding: number[], limit = 10) {
			const vectorStr = `[${embedding.join(',')}]`;
			return db.execute({
				sql: `SELECT * FROM vector_top_k('embeddings_idx', vector32(?), ?)
              JOIN embeddings ON embeddings.rowid = id`,
				args: [vectorStr, limit],
			});
		},

		db, // Expose for direct queries
	});
};
```

### Phase 3: SQLite Provider (Tauri Plugin)

**File**: `apps/epicenter/src/lib/providers/sqlite.ts`

```typescript
import Database from '@tauri-apps/plugin-sql';
import { defineCapabilities, type CapabilityContext } from '@epicenter/hq';

const DEFAULT_DEBOUNCE_MS = 100;

export type SqliteConfig = {
	/** Path to .db file (relative to app data dir) */
	dbPath: string;
	/** Debounce interval in milliseconds. @default 100 */
	debounceMs?: number;
};

export const sqlite = async <TTablesSchema extends TablesSchema>(
	{ id, tables }: CapabilityContext<TTablesSchema>,
	config: SqliteConfig,
) => {
	const { dbPath, debounceMs = DEFAULT_DEBOUNCE_MS } = config;

	// Initialize SQLite via Tauri plugin
	const db = await Database.load(`sqlite:${dbPath}`);

	// Convert workspace schema to SQL DDL (no vector columns)
	const drizzleTables = convertWorkspaceSchemaToDrizzle(schema);

	// Debounce state
	let syncTimeout: ReturnType<typeof setTimeout> | null = null;

	async function recreateTables() {
		for (const table of Object.values(drizzleTables)) {
			await db.execute(`DROP TABLE IF EXISTS "${table.name}"`);
			await db.execute(generateCreateTableSQL(table));
		}
	}

	async function rebuild() {
		await recreateTables();
		for (const table of tables.defined()) {
			const rows = table.getAllValid();
			if (rows.length > 0) {
				// Batch insert
				await db.execute(generateInsertSQL(table, rows));
			}
		}
	}

	function scheduleSync() {
		if (syncTimeout) clearTimeout(syncTimeout);
		syncTimeout = setTimeout(rebuild, debounceMs);
	}

	// Set up observers
	const unsubscribers = tables
		.defined()
		.map((table) => table.observeChanges(() => scheduleSync()));

	// Initial sync
	await rebuild();

	return defineCapabilities({
		async destroy() {
			if (syncTimeout) clearTimeout(syncTimeout);
			unsubscribers.forEach((unsub) => unsub());
			await db.close();
		},

		db, // Expose for direct queries
	});
};
```

### Phase 4: Tauri Configuration

**Add to `tauri.conf.json`**:

```json
{
	"app": {
		"security": {
			"headers": {
				"Cross-Origin-Opener-Policy": "same-origin",
				"Cross-Origin-Embedder-Policy": "require-corp"
			}
		}
	},
	"plugins": {
		"sql": {
			"preload": ["sqlite:workspace.db"]
		}
	}
}
```

**Add Tauri SQL plugin**:

```bash
cd apps/epicenter
cargo add tauri-plugin-sql
bun add @tauri-apps/plugin-sql
```

### Phase 5: Usage in Workspace

```typescript
import { defineWorkspace } from '@epicenter/hq';
import { turso } from './lib/providers/turso';
import { sqlite } from './lib/providers/sqlite';

const epicenterWorkspace = defineWorkspace({
	id: 'epicenter',

	tables: {
		recordings: {
			id: id(),
			transcript: text(),
			// ...
		},
		embeddings: {
			id: id(),
			recordingId: text(),
			embedding: json({ schema: type('number[]') }), // Stored as JSON in YJS
		},
	},

	providers: {
		// In-memory vector search (WebView WASM)
		turso: (ctx) => turso(ctx, { debounceMs: 100 }),

		// Filesystem persistence (Tauri plugin)
		sqlite: (ctx) =>
			sqlite(ctx, {
				dbPath: 'workspace.db',
				debounceMs: 100,
			}),
	},

	actions: ({ tables, providers }) => ({
		semanticSearch: defineQuery({
			input: type({ embedding: 'number[]', limit: 'number' }),
			handler: async ({ embedding, limit }) => {
				return providers.turso.vectorSearch(embedding, limit);
			},
		}),
	}),
});
```

## Open Questions

1. **Embedding model**: OpenAI `text-embedding-3-small` (1536d) or local model?
2. **Index on what?**: Full transcript? Chunked segments? Title + transcript?
3. **Vector column representation**: Store as JSON array in YJS, convert to F32_BLOB in Turso?
4. **Error logging**: Should providers share error logging pattern from existing sqlite.ts?

## Implementation Checklist

### Provider Infrastructure

- [ ] Create `apps/epicenter/src/lib/providers/` directory
- [ ] Implement `turso.ts` provider (in-memory WASM)
- [ ] Implement `sqlite.ts` provider (Tauri plugin)
- [ ] Add provider re-exports in `index.ts`

### Turso Provider (turso.ts)

- [ ] Add `@tursodatabase/database-wasm` dependency
- [ ] Configure Vite for WASM bundling (use `/vite` export)
- [ ] Implement connect/close/reinitialize pattern
- [ ] Implement debounced rebuild from YJS
- [ ] Create vector-aware table DDL generation
- [ ] Implement `vectorSearch()` method
- [ ] Add YJS change observers

### SQLite Provider (sqlite.ts)

- [ ] Add `@tauri-apps/plugin-sql` dependency
- [ ] Add `tauri-plugin-sql` to Rust dependencies
- [ ] Implement drop/recreate pattern
- [ ] Implement debounced rebuild from YJS
- [ ] Generate vanilla SQLite DDL (no vectors)
- [ ] Add YJS change observers

### Tauri Configuration

- [ ] Add COOP/COEP headers to `tauri.conf.json`
- [ ] Configure SQL plugin in `tauri.conf.json`
- [ ] Test SharedArrayBuffer availability in WebView

### Testing

- [ ] Test Turso WASM loads correctly in Tauri WebView
- [ ] Test vector search returns expected results
- [ ] Test SQLite file is accessible by external tools
- [ ] Test debounced sync fires correctly
- [ ] Test destroy() cleans up resources

## References

### Turso Documentation

- [AI & Embeddings](https://docs.turso.tech/features/ai-and-embeddings)
- [Vector Search Blog](https://turso.tech/blog/introducing-turso-in-the-browser)

### sqlite-vec

- [GitHub](https://github.com/asg017/sqlite-vec)
- [Documentation](https://alexgarcia.xyz/sqlite-vec/)

### Tauri

- [IPC Binary Data](https://v2.tauri.app/develop/calling-rust/)
- [Security Headers](https://v2.tauri.app/security/http-headers/)

### Existing Patterns

- `/packages/epicenter/src/capabilities/sqlite/sqlite.ts` - Debounced sync pattern
- `/apps/whispering/src-tauri/src/lib.rs` - Existing Rust commands
