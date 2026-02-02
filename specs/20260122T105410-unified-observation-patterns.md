# Unified Observation Patterns

## Status: Complete

## Problem Statement

The current observation APIs across schema, KV, and tables are inconsistent:

| Helper           | Current API         | Callback Receives                    | Validation                          |
| ---------------- | ------------------- | ------------------------------------ | ----------------------------------- |
| `schema`         | `.observe()`        | Full snapshot (`WorkspaceSchemaMap`) | N/A                                 |
| `schema.tables`  | `.observe()`        | Granular changes (`SchemaChange[]`)  | N/A                                 |
| `kv.{key}`       | `.observeChanges()` | Single key change (`KvChange`)       | None (raw values)                   |
| `kv` (top-level) | None                | N/A                                  | N/A                                 |
| `tables.{name}`  | `.observeChanges()` | `Map<string, TableRowChange>`        | Yes (RowResult discriminated union) |

**Issues:**

1. No top-level `kv.observe()` for watching all KV changes
2. Table observation includes validation logic and row reconstruction that consumers may not need
3. Inconsistent naming (`.observe()` vs `.observeChanges()`)
4. Table changes wrapped in complex `RowResult` discriminated union
5. Table observer reconstructs rows even when consumer only needs to know which IDs changed

## Goals

1. **Simplify**: One observer type per structure, minimal data in callbacks
2. **Unify**: Consistent `.observe()` naming across all structures
3. **Right tool for the job**: Snapshot for small/cold data (schema, KV), ID + action for large/hot data (tables)
4. **Zero waste**: Don't reconstruct rows in observer - let consumer fetch if needed
5. **SvelteMap-ready**: Design for future reactive Map integration (Svelte 5's `SvelteMap`)

## Design

### One Observer Per Structure

Each data structure gets exactly ONE observer type, chosen based on its characteristics:

| Structure  | Observer Type | Callback Receives                    | Rationale                                                                       |
| ---------- | ------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| **Schema** | Snapshot      | Full `WorkspaceSchemaMap`            | Small (~100 tables), changes rarely, triggers global rebuilds anyway            |
| **KV**     | Snapshot      | Full `KvSnapshot`                    | Tiny (~50 keys), changes occasionally                                           |
| **Tables** | ID + Action   | `Map<id, 'add'\|'update'\|'delete'>` | Large (1000s of rows), changes frequently, consumer decides if/how to fetch row |

### Schema: Snapshot Observer

```typescript
// Full schema snapshot on any change
schema.observe((snapshot: WorkspaceSchemaMap) => {
	// snapshot = { tables: {...}, kv: {...} }
	console.log('Schema changed:', snapshot);
});
```

**Already exists** - no changes needed.

### KV: Snapshot Observer (NEW)

```typescript
// Full KV snapshot on any change
kv.observe((snapshot: KvSnapshot) => {
	// snapshot = { theme: 'dark', fontSize: 14, ... }
	console.log('Settings changed:', snapshot);
});
```

**Use cases:**

- Persistence (stringify and save the whole settings object)
- Settings provider (React/Svelte context that holds all settings)
- Debugging/logging

### Tables: ID + Action Observer (SIMPLIFIED)

```typescript
// Just IDs and actions - no row data, no reconstruction, no validation
tables.posts.observe(
	(
		changes: Map<string, 'add' | 'update' | 'delete'>,
		transaction: Y.Transaction,
	) => {
		for (const [id, action] of changes) {
			if (action === 'delete') {
				removeFromCache(id);
			} else {
				// Consumer fetches row only if needed
				const result = tables.posts.get(id);
				if (result.status === 'valid') {
					updateCache(id, result.row);
				}
			}
		}
	},
);
```

**Key simplifications from current:**

1. No row reconstruction in observer - consumer calls `table.get(id)` if needed
2. No validation in observer - consumer validates if needed
3. Action is just a string, not a wrapper object
4. Map value is the action directly: `Map<string, 'add' | 'update' | 'delete'>`

**Use cases:**

- Persistence: Know which IDs changed, fetch and write only those
- UI updates: Know which rows to re-render, fetch fresh data
- Sync: Know which IDs to send, fetch current state
- Cache invalidation: Just need IDs, don't need row data at all

## Type Definitions

### Schema Types (Existing)

```typescript
/**
 * Full schema snapshot.
 */
type WorkspaceSchemaMap = {
	tables: Record<string, StoredTableSchema>;
	kv: Record<string, StoredKvSchema>;
};
```

### KV Types (New)

```typescript
/**
 * Full KV snapshot - all keys and their current values.
 *
 * This is the return type of kv.toJSON(), representing the
 * current state of all KV entries.
 */
type KvSnapshot<TKvDefinitionMap extends KvDefinitionMap> = {
	[K in keyof TKvDefinitionMap]?: KvValue<TKvDefinitionMap[K]['field']>;
};
```

### Table Types (Simplified)

```typescript
/**
 * Action that occurred on a row.
 */
type RowAction = 'add' | 'update' | 'delete';

/**
 * Map of row IDs to the action that occurred.
 *
 * The observer only tells you WHAT changed (IDs) and HOW (action).
 * To get the actual row data, call table.get(id).
 */
type RowChanges = Map<string, RowAction>;
```

**Key change from current `TableRowChange`:**

- Before: `Map<string, { action: 'add'; result: RowResult<TRow> } | ...>`
- After: `Map<string, 'add' | 'update' | 'delete'>` - just ID → action

### Why No Row Data in Observer?

1. **Zero waste**: Observer doesn't reconstruct rows that consumer might not need
2. **Consumer decides**: Fetch with validation (`get`), without validation (future `getRaw`), or not at all
3. **Simpler implementation**: No `reconstructRow()` calls in observer hot path
4. **Simpler types**: No generics needed for the change type itself

**Consumers who need row data:**

```typescript
tables.posts.observe((changes) => {
	for (const [id, action] of changes) {
		if (action === 'delete') continue;

		// Fetch row when needed
		const result = tables.posts.get(id);
		if (result.status === 'valid') {
			// use result.row
		}
	}
});
```

## API Summary

### Schema

````typescript
/**
 * Observe schema changes. Callback receives full snapshot on any change.
 *
 * @example
 * ```typescript
 * const unsub = schema.observe((snapshot) => {
 *   console.log('Tables:', Object.keys(snapshot.tables));
 *   rebuildValidators(snapshot);
 * });
 * ```
 */
schema.observe(callback: (snapshot: WorkspaceSchemaMap) => void): () => void
````

### KV

````typescript
/**
 * Observe KV changes. Callback receives full snapshot on any change.
 *
 * @example
 * ```typescript
 * const unsub = kv.observe((snapshot) => {
 *   console.log('Current theme:', snapshot.theme);
 *   saveSettingsToFile(snapshot);
 * });
 * ```
 */
kv.observe(callback: (snapshot: KvSnapshot) => void): () => void
````

### Tables

````typescript
/**
 * Observe table changes. Callback receives Map of row IDs to actions.
 *
 * Changes are batched per Y.Transaction - bulk operations fire one callback.
 * The transaction object enables origin checks (local vs remote).
 *
 * To get row data, call table.get(id) - the observer intentionally
 * does not include row data to avoid unnecessary reconstruction.
 *
 * @example
 * ```typescript
 * const unsub = tables.posts.observe((changes, transaction) => {
 *   // Skip our own changes (echo prevention)
 *   if (transaction.origin === 'local') return;
 *
 *   for (const [id, action] of changes) {
 *     if (action === 'delete') {
 *       removeFromUI(id);
 *     } else {
 *       // Fetch row data only when needed
 *       const result = tables.posts.get(id);
 *       if (result.status === 'valid') {
 *         updateUI(id, result.row);
 *       }
 *     }
 *   }
 * });
 * ```
 */
tables.posts.observe(
  callback: (changes: Map<string, 'add' | 'update' | 'delete'>, transaction: Y.Transaction) => void
): () => void
````

## Implementation Plan

### Phase 1: Add KV Observer (Non-breaking)

Add `kv.observe()` method that emits full snapshot on any change.

**Files to modify:**

- `packages/epicenter/src/core/kv/core.ts` - Add `observe()` method

**Implementation:**

```typescript
observe(callback: (snapshot: KvSnapshot) => void): () => void {
  const handler = () => {
    callback(this.toJSON());
  };
  ykvMap.observeDeep(handler);
  return () => ykvMap.unobserveDeep(handler);
}
```

### Phase 2: Simplify Table Observer (Breaking)

1. Remove `TableRowChange` type entirely
2. Change callback signature from `Map<string, TableRowChange>` to `Map<string, 'add' | 'update' | 'delete'>`
3. Remove `reconstructRow()` calls from observer implementation
4. Remove validation from observer implementation
5. Rename `observeChanges` to `observe` for consistency
6. Update all consumers

**Files to modify:**

- `packages/epicenter/src/core/tables/table-helper.ts`
  - Remove `TableRowChange` type (lines 133-136)
  - Simplify `observeChanges` implementation - just queue `{ id, action }`, no row reconstruction
  - Rename to `observe`
- `packages/epicenter/src/extensions/sqlite/sqlite.ts` - Update consumer
- `packages/epicenter/src/extensions/markdown/markdown.ts` - Update consumer
- `apps/tab-manager/src/entrypoints/background.ts` - Update consumer
- All test files using `observeChanges`

**Simplified observer implementation:**

```typescript
observe(
  callback: (changes: Map<string, 'add' | 'update' | 'delete'>, transaction: Y.Transaction) => void
): () => void {
  let pendingChanges = new Map<string, 'add' | 'update' | 'delete'>();
  let pendingTransaction: Y.Transaction | null = null;

  const afterTransactionHandler = () => {
    if (pendingChanges.size > 0 && pendingTransaction) {
      callback(pendingChanges, pendingTransaction);
      pendingChanges = new Map();
      pendingTransaction = null;
    }
  };

  ydoc.on('afterTransaction', afterTransactionHandler);

  const queueChange = (id: string, action: 'add' | 'update' | 'delete', transaction: Y.Transaction) => {
    pendingTransaction = transaction;
    pendingChanges.set(id, action);
  };

  // ... rest of observer setup (table-level and row-level observers)
  // but WITHOUT reconstructRow() or validation calls
}
```

### Phase 3: Update Persistence Extension

Update `workspace-persistence.ts` to use the new APIs:

```typescript
// Before
const schemaMap = ydoc.getMap('schema');
schemaMap.observeDeep(handler);

// After
const unsubSchema = schema.observe((snapshot) => {
	scheduleSchemaJsonSave(snapshot);
});

const unsubKv = kv.observe((snapshot) => {
	scheduleKvJsonSave(snapshot);
});
```

## Migration Guide

### For Table Observers

**Before (current):**

```typescript
tables.posts.observeChanges((changes) => {
	for (const [id, change] of changes) {
		if (change.action === 'delete') continue;

		// Row data was included in change
		if (change.result.status === 'valid') {
			console.log('Row:', change.result.row);
		}
	}
});
```

**After (simplified):**

```typescript
tables.posts.observe((changes) => {
	for (const [id, action] of changes) {
		if (action === 'delete') continue;

		// Fetch row data explicitly
		const result = tables.posts.get(id);
		if (result.status === 'valid') {
			console.log('Row:', result.row);
		}
	}
});
```

### For Consumers That Only Need IDs

Some consumers (like cache invalidation) only need to know which IDs changed:

```typescript
// Before: had to ignore the row data
tables.posts.observeChanges((changes) => {
	for (const [id, change] of changes) {
		invalidateCache(id);
	}
});

// After: cleaner - no unused data
tables.posts.observe((changes) => {
	for (const [id, action] of changes) {
		invalidateCache(id);
	}
});
```

## Batching Behavior

All observers are batched per Y.Transaction:

| Structure | Batching        | Rationale                                              |
| --------- | --------------- | ------------------------------------------------------ |
| Schema    | Per-transaction | Ensures consistent state (all schema changes together) |
| KV        | Per-transaction | Ensures consistent state (all KV changes together)     |
| Tables    | Per-transaction | Already implemented; bulk ops fire once                |

This is achieved using `ydoc.on('afterTransaction', handler)` pattern.

## Future: SvelteMap Integration

The simplified observer enables clean SvelteMap integration:

```typescript
// Future API concept
const postsMap: SvelteMap<string, TRow> = tables.posts.toSvelteMap();

// Internally:
// 1. Initial population from table.getAll()
// 2. observe() to track changes
// 3. On add/update: fetch row with table.get(id), update SvelteMap
// 4. On delete: remove from SvelteMap
```

## References

- [Svelte 5 SvelteMap](https://svelte.dev/docs/svelte/svelte-reactivity) - Reactive Map implementation
- Current table observation: `packages/epicenter/src/core/tables/table-helper.ts:538`
- Current schema observation: `packages/epicenter/src/core/schema-helper/schema-helper.ts:929`
- Current KV per-key observation: `packages/epicenter/src/core/kv/kv-helper.ts:202`
