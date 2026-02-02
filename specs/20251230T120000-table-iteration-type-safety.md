# Table Iteration Type Safety

**Created**: 2025-12-30T12:00:00
**Status**: Implemented

## Problem Statement

When iterating over a heterogeneous collection of table helpers in Epicenter, TypeScript loses the correlation between each table and its associated configuration. This forces the use of `@ts-expect-error` comments throughout the codebase.

### The Core Issue

The `tables.defined()` method returns `TableHelper<TSchema[keyof TSchema]>[]`, which is a union type of all possible table schemas. When we pair each table with its resolved configuration:

```typescript
const tableWithConfigs = tables.defined().map((table) => ({
	table, // TableHelper<TSchema['posts']> | TableHelper<TSchema['authors']> | ...
	tableConfig: resolveConfig(table), // ResolvedTableConfig<TSchema['posts']> | ResolvedTableConfig<TSchema['authors']> | ...
}));
```

During iteration, TypeScript cannot correlate which specific table type matches which config type:

```typescript
for (const { table, tableConfig } of tableWithConfigs) {
	const rows = table.getAllValid(); // Row<TSchema[keyof TSchema]>[] - union of ALL row types

	// tableConfig.serialize expects the SPECIFIC row type for THIS table
	// but we only have the union type
	tableConfig.serialize({ row: rows[0] }); // Type error!
}
```

### Why TypeScript Can't Narrow This

TypeScript's type system treats `table` and `tableConfig` as independent union types. Even though at runtime they're always correlated (the posts table always pairs with posts config), TypeScript sees:

- `table`: `TableHelper<PostsSchema> | TableHelper<AuthorsSchema>`
- `tableConfig`: `ResolvedTableConfig<PostsSchema> | ResolvedTableConfig<AuthorsSchema>`

When you call `tableConfig.serialize({ row })`, TypeScript must ensure the call is valid for ALL possible combinations, not just the correlated ones. This is the "correlated record types" problem.

## Current Workarounds in Codebase

The codebase currently uses `@ts-expect-error` comments to suppress these errors. Found in:

### SQLite Provider (`sqlite-provider.ts`)

```typescript
// Line 188
// @ts-expect-error SerializedRow<TSchema[string]>[] is not assignable to InferInsertModel<DrizzleTable>[] due to union type from $tables() iteration

// Line 279
// @ts-expect-error SerializedRow<TSchema[string]>[] is not assignable to InferInsertModel<DrizzleTable>[] due to union type from $tables() iteration

// Line 349
// @ts-expect-error InferSelectModel<DrizzleTable> is not assignable to InferInsertModel<TableHelper<TSchema[string]>> due to union type from $tables() iteration
```

### Markdown Provider (`markdown-provider.ts`)

```typescript
// Lines 371-373
tableConfig.serialize({
	// @ts-expect-error SerializedRow<TSchema[string]> is not assignable to SerializedRow<TTableSchema> due to union type from $tables() iteration
	row: serialized,
	// @ts-expect-error TableHelper<TSchema[keyof TSchema]> is not assignable to TableHelper<TSchema[string]> due to union type from $tables() iteration
	table,
});

// Similar patterns at lines 668, 911, 1017-1019, 1157-1159, 1337
```

**Total: 12 `@ts-expect-error` comments** directly related to this issue.

## Solution Analysis

### Solution A: Generic Helper Function with Callback

**Concept**: Encapsulate the type assertion in a single helper function that processes one table at a time with full type safety within the callback.

```typescript
// Create the discriminated union array
function createTableContexts<TSchema extends WorkspaceSchema>(
	tables: Tables<TSchema>,
	configs: { [K in keyof TSchema]: ResolvedTableConfig<TSchema[K]> },
): TableContext<TSchema>[] {
	return tables.defined().map((table) => ({
		name: table.name as keyof TSchema,
		table,
		config: configs[table.name as keyof TSchema],
	})) as TableContext<TSchema>[];
}

// Usage with type guard
function isTableContext<K extends keyof TSchema>(
	ctx: TableContext<TSchema>,
	name: K,
): ctx is {
	name: K;
	table: TableHelper<TSchema[K]>;
	config: ResolvedTableConfig<TSchema[K]>;
} {
	return ctx.name === name;
}
```

**Pros**:

- Theoretically enables TypeScript narrowing via discriminant
- More idiomatic TypeScript pattern
- Could enable exhaustive switch statements

**Cons**:

- TypeScript doesn't actually narrow discriminated unions during iteration well
- Requires knowing table names at compile time for narrowing
- More complex implementation
- Doesn't solve the iteration problem directly

### Solution C: Per-Table Processing Factory

**Concept**: Instead of iterating over all tables, create typed processors for each table that are invoked individually.

```typescript
function createTableProcessor<
	TSchema extends WorkspaceSchema,
	K extends keyof TSchema,
>(
	tables: Tables<TSchema>,
	configs: { [K in keyof TSchema]: ResolvedTableConfig<TSchema[K]> },
	tableName: K,
) {
	const table = tables[tableName];
	const config = configs[tableName];

	return {
		process(callback: (row: Row<TSchema[K]>) => void) {
			for (const row of table.getAllValid()) {
				callback(row);
			}
		},
		serialize(row: Row<TSchema[K]>) {
			return config.serialize({ row: row.toJSON(), table });
		},
	};
}

// Usage - requires explicit table names
const postsProcessor = createTableProcessor(tables, configs, 'posts');
const authorsProcessor = createTableProcessor(tables, configs, 'authors');

postsProcessor.process((row) => {
	// Fully typed as PostRow
});
```

**Pros**:

- Complete type safety
- No type assertions needed
- Clear, explicit code

**Cons**:

- Loses the ability to iterate over all tables dynamically
- Requires listing every table explicitly
- Doesn't scale with dynamic table schemas
- Fundamental mismatch with current use cases

### Solution D: Type-Safe forEachTable Helper

**Concept**: A higher-order function that internally handles the type assertion but provides a fully typed callback interface.

```typescript
type TableIteratorCallback<TSchema extends WorkspaceSchema> = <
	K extends keyof TSchema,
>(context: {
	name: K;
	table: TableHelper<TSchema[K]>;
	config: ResolvedTableConfig<TSchema[K]>;
}) => void | Promise<void>;

function forEachTable<TSchema extends WorkspaceSchema>(
	tableWithConfigs: Array<{
		table: TableHelper<TSchema[keyof TSchema]>;
		tableConfig: ResolvedTableConfig<TSchema[keyof TSchema]>;
	}>,
	callback: TableIteratorCallback<TSchema>,
): void {
	for (const { table, tableConfig } of tableWithConfigs) {
		// Single type assertion here
		(callback as Function)({
			name: table.name,
			table,
			config: tableConfig,
		});
	}
}

// Usage
forEachTable(tableWithConfigs, ({ name, table, config }) => {
	// TypeScript infers K from usage, but doesn't actually narrow
	const rows = table.getAllValid();
	// Still union types inside...
});
```

**Pros**:

- Clean API
- Encapsulates assertion

**Cons**:

- The callback parameter types are still unions
- TypeScript can't infer which specific K is being used per iteration
- Doesn't actually solve the problem

### Solution E: Accept @ts-expect-error with Documentation

**Concept**: Keep the current pattern but standardize and document it.

```typescript
/**
 * Process all tables with their configs.
 *
 * NOTE: @ts-expect-error is required here because TypeScript cannot correlate
 * union types during iteration. At runtime, table and tableConfig are always
 * correctly paired. See specs/20251230T120000-table-iteration-type-safety.md
 */
for (const { table, tableConfig } of tableWithConfigs) {
	const rows = table.getAllValid();
	for (const row of rows) {
		const serialized = row.toJSON();
		// @ts-expect-error Union type correlation - see table-iteration-type-safety.md
		const { frontmatter, body, filename } = tableConfig.serialize({
			row: serialized,
			table,
		});
	}
}
```

**Pros**:

- No code changes needed
- Honest about TypeScript's limitations
- Well-documented for future maintainers
- Doesn't introduce unnecessary complexity

**Cons**:

- Doesn't reduce the number of @ts-expect-error comments
- Type safety is opt-out rather than opt-in

## Recommendation: Solution A with Standardization

**Primary recommendation**: Implement **Solution A (Generic Helper Function)** combined with documentation from **Solution E**.

### Rationale

1. **Practical benefit**: Reduces 12 `@ts-expect-error` comments to ~4-6 (one per usage site of the helper)

2. **Type safety improvement**: Code inside callbacks is fully type-safe, which is where the actual business logic lives

3. **Minimal complexity**: Doesn't require major architectural changes or complex type gymnastics

4. **Honest about limitations**: Documents that this is a TypeScript limitation, not a code smell

5. **Future-proof**: If TypeScript ever adds correlated record type support, migration would be straightforward

### Implementation Plan

1. Create `processTableWithConfig` helper in `packages/epicenter/src/core/db/table-iteration.ts`

2. Update markdown provider to use the helper (largest impact: 8 `@ts-expect-error` removals)

3. Update SQLite provider to use the helper (3 `@ts-expect-error` removals)

4. Add JSDoc explaining the pattern and linking to this spec

## Handoff Prompt

Copy-paste this prompt to have an agent implement the solution:

---

**Task**: Implement type-safe table iteration helper for Epicenter

**Context**: See `specs/20251230T120000-table-iteration-type-safety.md` for full analysis.

**Implementation Steps**:

1. Create new file `packages/epicenter/src/core/db/table-iteration.ts`:

````typescript
import type { TableSchema, WorkspaceSchema } from '../schema';
import type { Row, TableHelper } from './table-helper';

/**
 * Process a table with its correlated configuration in a type-safe manner.
 *
 * TypeScript cannot correlate union types during iteration over heterogeneous
 * collections. This helper encapsulates the necessary type assertion while
 * providing a fully type-safe callback interface.
 *
 * @see specs/20251230T120000-table-iteration-type-safety.md
 *
 * @example
 * ```typescript
 * for (const { table, tableConfig } of tableWithConfigs) {
 *   processTableWithConfig(table, tableConfig, ({ table, config }) => {
 *     // Fully typed inside this callback
 *     const rows = table.getAllValid();
 *     for (const row of rows) {
 *       config.serialize({ row: row.toJSON(), table });
 *     }
 *   });
 * }
 * ```
 */
export function processTableWithConfig<
	TTableSchema extends TableSchema,
	TConfig,
>(
	table: TableHelper<TTableSchema>,
	config: TConfig,
	callback: (context: {
		table: TableHelper<TTableSchema>;
		config: TConfig;
	}) => void | Promise<void>,
): void | Promise<void> {
	return callback({ table, config });
}

/**
 * Async version of processTableWithConfig for async callbacks.
 */
export async function processTableWithConfigAsync<
	TTableSchema extends TableSchema,
	TConfig,
>(
	table: TableHelper<TTableSchema>,
	config: TConfig,
	callback: (context: {
		table: TableHelper<TTableSchema>;
		config: TConfig;
	}) => Promise<void>,
): Promise<void> {
	await callback({ table, config });
}
````

2. Export from `packages/epicenter/src/core/db/index.ts`

3. Update `markdown-provider.ts` - replace direct `@ts-expect-error` usage with the helper at these locations:
   - Lines 370-375 (writeRowToMarkdown)
   - Lines 663-670 (file watcher deserialize)
   - Lines 908-912 (similar pattern)
   - Lines 1015-1021 (buildInitialTracking)
   - Lines 1155-1160 (similar pattern)
   - Lines 1335-1338 (similar pattern)

4. Update `sqlite-provider.ts` - replace direct `@ts-expect-error` usage:
   - Lines 186-189 (rebuildSqlite insert)
   - Lines 277-280 (similar)
   - Lines 347-350 (pushFromSqlite)

5. Each call site should have a single comment:

```typescript
// Type assertion required - see specs/20251230T120000-table-iteration-type-safety.md
// @ts-expect-error Union type correlation during heterogeneous iteration
processTableWithConfig(table, tableConfig, ({ table, config }) => {
	// ... type-safe code here
});
```

**Expected outcome**: Reduce `@ts-expect-error` count from 12 to ~6, with all business logic inside type-safe callbacks.

---

## Implementation (2025-12-30)

### What Was Actually Implemented

Instead of the callback-based `processTableWithConfig` helper (Solution A), we implemented a simpler `zip()` method on the Tables object that returns correlated tuples.

#### The `zip()` API

```typescript
// Added to createTables() return object in core.ts
zip<TConfigs extends Record<keyof TSchema, unknown>>(
  configs: TConfigs,
): Array<{
  [K in keyof TSchema]: {
    name: K;
    table: TableHelper<TSchema[K]>;
    paired: TConfigs[K];
  };
}[keyof TSchema]> {
  // ... implementation
}
```

#### Usage Pattern

```typescript
// BEFORE: Scattered @ts-expect-error comments
const tableWithConfigs = tables.defined().map((table) => ({
	table,
	tableConfig: configs[table.name],
}));
for (const { table, tableConfig } of tableWithConfigs) {
	// @ts-expect-error
	tableConfig.serialize({ row, table });
}

// AFTER: Single cast encapsulated in zip(), rename 'paired' at destructure
for (const { table, paired: tableConfig } of tables.zip(resolvedConfigs)) {
	tableConfig.serialize({ row, table }); // Type-safe!
}

// SQLite provider example
for (const { table, paired: drizzleTable } of tables.zip(drizzleTables)) {
	await sqliteDb.insert(drizzleTable).values(rows);
}
```

### Why `zip` and `paired`?

1. **`zip`**: Familiar functional programming term for pairing two collections
2. **`paired`**: Generic name that works for any paired value (configs, drizzle tables, etc.)
3. **Rename at destructure**: `paired: tableConfig` or `paired: drizzleTable` gives domain-specific clarity

### Why This Approach

1. **Simpler**: No callback indirection, just a standard for-of loop
2. **Follows existing pattern**: Mirrors `defined()` but with config correlation
3. **Single point of type assertion**: The cast is inside `zip()`, not scattered across usage sites
4. **Flexible**: Works with any configs object that has matching keys

### Results

| File                 | @ts-expect-error Before | After | Notes                      |
| -------------------- | ----------------------- | ----- | -------------------------- |
| markdown-provider.ts | 8                       | 0     | All eliminated             |
| sqlite-provider.ts   | 4                       | 2     | 2 remain (different issue) |
| **Total**            | **12**                  | **2** | **83% reduction**          |

The remaining 2 errors in sqlite-provider.ts are a _different_ TypeScript limitation: `SerializedRow<TSchema[keyof TSchema]>[]` not assignable to `InferInsertModel<DrizzleTable>[]`. This is a Drizzle ORM type incompatibility that `zip()` can't solve since it happens when passing data TO Drizzle, not when iterating tables.

### Additional Changes

1. **Renamed `createEpicenterDb` → `createTables`**: More accurate name for what the function does
2. **Documentation**: Created `docs/articles/encapsulating-type-assertions.md` explaining the pattern
3. **Fixed Object.fromEntries cast**: Added `as unknown as` and explanatory comment

### Commits Made

1. `refactor(db): rename createEpicenterDb to createTables`
2. `feat(db): add zip() for type-safe table iteration with configs`

## References

- TypeScript issue on correlated record types: https://github.com/microsoft/TypeScript/issues/35101
- TypeScript mapped types: https://www.typescriptlang.org/docs/handbook/2/mapped-types.html
- Discriminated unions: https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions
