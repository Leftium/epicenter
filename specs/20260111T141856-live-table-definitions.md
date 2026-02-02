# Live Table Definitions via Y.Doc

## Problem

Currently, table and KV helpers receive **static** definitions at creation time:

```typescript
createTables(ydoc, tableDefinitions); // static tableDefinitions
createTableHelper({ schema: tableDefinition.fields }); // static schema
```

But the definitions ARE stored in the Y.Doc (via `createDefinition`):

```
Y.Doc
├── 'definition'
│   ├── name
│   ├── slug
│   ├── tables → Y.Map<tableName, TableDefinition>
│   └── kv → Y.Map<kvName, KvDefinition>
├── 'tables' (row data)
└── 'kv' (kv data)
```

This creates a mismatch:

1. **Static `definitions`**: `tables.definitions` is the raw object passed in, not live CRDT state
2. **Static validation**: Validators are compiled once from static schema
3. **No per-table access**: Can't do `client.tables.posts.definition`

## Proposed Solution

### API Change

```typescript
// Current
client.tables.definitions; // static object
client.tables.posts.schema; // static FieldSchemaMap

// Proposed
client.tables.posts.definition; // live getter → reads from Y.Doc['definition'].tables.posts
client.tables.definitions; // live getter → reads from Y.Doc['definition'].tables (Y.Map)

client.kv.theme.definition; // live getter → reads from Y.Doc['definition'].kv.theme
client.kv.definitions; // live getter → reads from Y.Doc['definition'].kv (Y.Map)
```

### Key Insight

We don't need to pass anything new to `createTables`/`createKv`. They already have `ydoc`, and the definition is at a known location:

```typescript
// Inside createTableHelper
get definition() {
  const definitionMap = ydoc.getMap('definition');
  const tablesDefinitions = definitionMap.get('tables') as Y.Map<TableDefinitionYMap>;
  return tablesDefinitions.get(tableName);
}
```

## Implementation Plan

### Commit 1: Expose `.definition` getter on helpers

**Goal**: Add live definition access without changing validation behavior.

**Files to modify**:

- `packages/epicenter/src/core/tables/table-helper.ts`
- `packages/epicenter/src/core/tables/create-tables.ts`
- `packages/epicenter/src/core/kv/kv-helper.ts`
- `packages/epicenter/src/core/kv/core.ts`

**Changes**:

1. **`createTableHelper`**: Add `definition` getter that reads from Y.Doc

   ```typescript
   function createTableHelper({ ydoc, tableName, ytables, schema }) {
   	// ... existing code ...

   	return {
   		// ... existing methods ...

   		/**
   		 * Live table definition from Y.Doc CRDT state.
   		 * Reads from Y.Doc['definition'].tables[tableName] on each access.
   		 */
   		get definition() {
   			const definitionMap = ydoc.getMap<Y.Map<unknown>>('definition');
   			const tablesDefinitions = definitionMap.get('tables') as
   				| Y.Map<TableDefinitionYMap>
   				| undefined;
   			return tablesDefinitions?.get(tableName) ?? null;
   		},
   	};
   }
   ```

2. **`createTables`**: Change `definitions` to be a live getter

   ```typescript
   // Before (static)
   definitions: tableDefinitions,

   // After (live getter)
   get definitions() {
     const definitionMap = ydoc.getMap<Y.Map<unknown>>('definition');
     return definitionMap.get('tables') as Y.Map<TableDefinitionYMap>;
   },
   ```

3. **`createKvHelper`**: Add `definition` getter

   ```typescript
   get definition() {
     const definitionMap = ydoc.getMap<Y.Map<unknown>>('definition');
     const kvDefinitions = definitionMap.get('kv') as Y.Map<KvDefinition> | undefined;
     return kvDefinitions?.get(keyName) ?? null;
   },
   ```

4. **`createKv`**: Change `definitions` to be a live getter
   ```typescript
   get definitions() {
     const definitionMap = ydoc.getMap<Y.Map<unknown>>('definition');
     return definitionMap.get('kv') as Y.Map<KvDefinition>;
   },
   ```

**Validation**: Still uses static `schema` parameter (no behavior change for validation).

**Breaking change**: `definitions` changes from plain object to Y.Map. Code that does `Object.entries(tables.definitions)` will break. Need to use Y.Map iteration instead.

---

### Commit 2: Live validation with cached validators

**Goal**: Validation uses live schema from Y.Doc. Validators are cached and invalidated on schema change.

**Files to modify**:

- `packages/epicenter/src/core/tables/table-helper.ts`
- `packages/epicenter/src/core/kv/kv-helper.ts`

**Changes**:

1. **Remove static `schema` parameter** from `createTableHelper`

   ```typescript
   // Before
   function createTableHelper({ ydoc, tableName, ytables, schema }) {
   	const typeboxSchema = fieldsSchemaToTypebox(schema);
   	const rowValidator = Compile(typeboxSchema);
   	// ...
   }

   // After
   function createTableHelper({ ydoc, tableName, ytables }) {
   	let cachedValidator: ReturnType<typeof Compile> | null = null;
   	let cachedSchemaVersion = 0;

   	const getValidator = () => {
   		if (!cachedValidator) {
   			const schema = getFieldsFromDefinition();
   			if (schema) {
   				cachedValidator = Compile(fieldsSchemaToTypebox(schema));
   			}
   		}
   		return cachedValidator;
   	};

   	const invalidateValidator = () => {
   		cachedValidator = null;
   	};

   	// Observe schema changes
   	const definitionMap = ydoc.getMap<Y.Map<unknown>>('definition');
   	const tablesDefinitions = definitionMap.get(
   		'tables',
   	) as Y.Map<TableDefinitionYMap>;
   	const tableDefinition = tablesDefinitions?.get(tableName);
   	const fieldsMap = tableDefinition?.get('fields') as
   		| Y.Map<FieldSchema>
   		| undefined;

   	fieldsMap?.observe(() => {
   		invalidateValidator();
   	});

   	// ... rest of implementation using getValidator() instead of rowValidator ...
   }
   ```

2. **Update validation calls** to use lazy validator

   ```typescript
   const validateRow = (
   	id: string,
   	row: Record<string, unknown>,
   ): RowResult<TRow> => {
   	const validator = getValidator();
   	if (!validator) {
   		// No schema defined yet - treat as valid? Or return error?
   		return { status: 'valid', row: row as TRow };
   	}
   	if (validator.Check(row)) {
   		return { status: 'valid', row: row as TRow };
   	}
   	return {
   		status: 'invalid',
   		id,
   		tableName,
   		errors: validator.Errors(row),
   		row,
   	};
   };
   ```

3. **Handle schema not present**: During initial sync, schema might not exist yet. Need graceful handling.

4. **Cleanup observer on destroy**: If table helper needs cleanup, unobserve the fields map.

**Edge cases**:

- Schema doesn't exist in Y.Doc yet (initial sync)
- Fields are added/removed (not just modified)
- Concurrent schema changes during validation

---

## Migration Path

### For `definitions` users

```typescript
// Before (static object)
for (const [tableName, def] of Object.entries(tables.definitions)) {
	console.log(def.name);
}

// After (Y.Map)
for (const [tableName, def] of tables.definitions.entries()) {
	console.log(def.get('name'));
}

// Or use defined() which still works
for (const table of tables.defined()) {
	const def = table.definition;
	console.log(def?.get('name'));
}
```

### For `tableHelper.schema` users

```typescript
// Before (static FieldSchemaMap)
const fields = table.schema;

// After (live from definition)
const fields = table.definition?.get('fields');
```

---

## Open Questions

1. **Should `.definition` return null or throw if not found?**
   - Recommendation: Return null (graceful handling for sync scenarios)

2. **Should validation fail if schema not in Y.Doc?**
   - Recommendation: Treat as valid (permissive during sync)
   - Alternative: Return "schema_missing" status

3. **Keep static `schema` on helper for TypeScript inference?**
   - The static schema is still useful for TypeScript types
   - Could keep as `$staticSchema` while `definition` is live

4. **Breaking change for `definitions`?**
   - Current: Plain object
   - Proposed: Y.Map
   - Alternative: Keep as `staticDefinitions`, add `definitions` as live getter

---

## Todo

- [x] Commit 1: Expose `.definition` getter on table/kv helpers
  - [x] Add `definition` getter to `createTableHelper`
  - [x] Add `definition` getter to `createKvHelper`
  - [x] Export `TableDefinitionYMap` type for users
- [ ] ~~Change `definitions` to live getter on `createTables`~~ (decided to keep static for compatibility)
  - [ ] ~~Change `definitions` to live getter on `createKv`~~ (decided to keep static for compatibility)
  - [x] Tests pass (104 tests across table/kv modules)

- [ ] Commit 2: Live validation with cached validators (DEFERRED)
  - Decided this is over-engineering for rare edge case
  - Schema changes should trigger client reinitialization at app layer
  - [ ] Remove static `schema` parameter from `createTableHelper`
  - [ ] Implement cached validator with invalidation
  - [ ] Observe fields Y.Map for changes
  - [ ] Handle schema-not-found edge case
  - [ ] Update `createKvHelper` similarly
  - [ ] Add tests for schema change scenarios
  - [ ] Performance test validator caching

## Review

### Changes Made

**table-helper.ts**:

- Added `TableDefinitionYMap` type (exported) for the Y.Map holding table definitions
- Added `getDefinition()` internal helper that reads from `Y.Doc['definition'].tables[tableName]`
- Added `definition` getter on table helper that returns `TableDefinitionYMap | null`

**create-tables.ts**:

- Re-exported `TableDefinitionYMap` type

**kv-helper.ts**:

- Changed `import type * as Y` to `import * as Y` (needed for runtime access)
- Added `ydoc` parameter to `createKvHelper`
- Added `getDefinition()` internal helper that reads from `Y.Doc['definition'].kv[keyName]`
- Added `definition` getter on KV helper that returns `KvDefinition | null`
- Updated `createKvHelpers` to pass `ydoc` through to each helper

### API After This Change

```typescript
// Table helpers
client.tables.posts.definition; // Y.Map (live) | null
client.tables.posts.schema; // FieldSchemaMap (static)
client.tables.definitions; // TableDefinitionMap (static, unchanged)

// KV helpers
client.kv.theme.definition; // KvDefinition (live) | null
client.kv.theme.field; // FieldSchema (static)
client.kv.definitions; // KvDefinitionMap (static, unchanged)
```

### Design Decisions

1. **Keep `definitions` static**: Changing to Y.Map would break existing code using `Object.entries()`. The per-helper `.definition` getter covers the live access use case.

2. **KV returns `KvDefinition` directly, not Y.Map**: The KV definition is stored as a plain object in Y.Doc (not a nested Y.Map), so we return the whole `KvDefinition` object.

3. **Table returns `Y.Map<unknown>`**: The table definition is stored as a Y.Map with nested fields Y.Map, so we return the raw Y.Map for flexibility.

4. **Deferred Commit 2**: Live validation with cached validators is over-engineering. Schema changes should trigger client reinitialization at the app layer.
