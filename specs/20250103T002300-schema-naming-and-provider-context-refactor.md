# Schema Naming and Provider Context Refactor

**Date**: 2025-01-03
**Status**: In Progress

## Summary

Refactor the schema type system and `ProviderContext` to:

1. Rename `WorkspaceSchema` to `TablesSchema` (it only represents tables)
2. Create a new `WorkspaceSchema` umbrella type containing `{ tables, kv }`
3. Rename ambiguous `TSchema` generics to `TTables` or `TTableSchema` based on context
4. Remove redundant `schema` property from `ProviderContext` (access via `tables.*.schema`)
5. Add optional `kv` property to `ProviderContext`
6. Add `require.*()` helpers for providers that need specific capabilities

## Motivation

### Current Problems

1. **Misleading naming**: `WorkspaceSchema` only contains tables, but "workspace" conceptually includes both tables AND KV storage.

2. **Redundant `schema` in ProviderContext**: Providers receive both `schema` (all tables) and `tables` (which already has `table.schema` per-table). This is redundant.

3. **Ambiguous `TSchema` generic**: Used for three different things:
   - `WorkspaceSchema` (all tables)
   - `TableSchema` (single table)
   - `CombinedStandardSchema` (JSON field validation)

4. **No KV in providers**: KV storage exists but isn't passed to providers.

## Design Decisions

### Naming Convention

Based on Oracle consultation and industry patterns (Drizzle, tRPC, Prisma):

| Current           | New               | Description                  |
| ----------------- | ----------------- | ---------------------------- |
| `WorkspaceSchema` | `TablesSchema`    | Collection of all tables     |
| `TableSchema`     | `TableSchema`     | Single table (keep)          |
| `KvSchema`        | `KvSchema`        | Collection of KV keys (keep) |
| `KvFieldSchema`   | `KvFieldSchema`   | Single KV field (keep)       |
| (new)             | `WorkspaceSchema` | Umbrella: `{ tables, kv }`   |

Generic parameter naming (shorter, concept-focused):

- `TTables` not `TTablesSchema`
- `TKv` not `TKvSchema`
- `TTableSchema` for single table contexts

### Required (Final Decision)

Both `tables` and `kv` are **required** (never undefined):

```typescript
type ProviderContext<TTablesSchema, TKvSchema> = {
	tables: Tables<TTablesSchema>; // Required
	kv: Kv<TKvSchema>; // Required
	// ...
};
```

This matches runtime reality - every workspace has both. KV can be empty (`{}` schema) if not used. No `require.*()` helpers needed.

## Detailed Changes

### Phase 1: Rename `WorkspaceSchema` to `TablesSchema`

**File: `packages/epicenter/src/core/schema/fields/types.ts`**

```typescript
// BEFORE (line 379)
export type WorkspaceSchema = Record<string, TableSchema>;

// AFTER
export type TablesSchema = Record<string, TableSchema>;

/** @deprecated Use TablesSchema instead */
export type WorkspaceSchema = TablesSchema;
```

Update all imports/usages across the codebase.

### Phase 2: Create New `WorkspaceSchema` Umbrella Type

**File: `packages/epicenter/src/core/schema/fields/types.ts`**

```typescript
/**
 * Full workspace schema containing all data definitions.
 *
 * A workspace can have:
 * - `tables`: CRUD collections with YJS-backed storage
 * - `kv`: Key-value settings storage
 */
export type WorkspaceSchema<
	TTables extends TablesSchema = TablesSchema,
	TKv extends KvSchema = KvSchema,
> = {
	tables: TTables;
	kv: TKv;
};
```

### Phase 3: Rename `TSchema` Generics

**Context-aware renaming:**

| File                 | Current                           | New                                | Reason                             |
| -------------------- | --------------------------------- | ---------------------------------- | ---------------------------------- |
| `provider.shared.ts` | `TSchema extends WorkspaceSchema` | `TTables extends TablesSchema`     | All tables                         |
| `contract.ts`        | `TSchema extends WorkspaceSchema` | `TTables extends TablesSchema`     | All tables                         |
| `table-helper.ts`    | `TSchema extends TableSchema`     | `TTableSchema extends TableSchema` | Single table                       |
| `to-arktype.ts`      | `TSchema extends TableSchema`     | `TTableSchema extends TableSchema` | Single table                       |
| `validators.ts`      | `TSchema extends TableSchema`     | `TTableSchema extends TableSchema` | Single table                       |
| `yjs.ts`             | `TSchema extends TableSchema`     | `TTableSchema extends TableSchema` | Single table                       |
| `types.ts` (JSON)    | `TSchema extends StandardSchema`  | Keep as `TSchema`                  | JSON validation (context is clear) |

### Phase 4: Update `ProviderContext`

**File: `packages/epicenter/src/core/provider.shared.ts`**

```typescript
// BEFORE
export type ProviderContext<TSchema extends WorkspaceSchema = WorkspaceSchema> =
	{
		id: string;
		providerId: string;
		ydoc: Y.Doc;
		schema: TSchema;
		tables: Tables<TSchema>;
		paths: ProviderPaths | undefined;
	};

// AFTER
export type ProviderContext<
	TTables extends TablesSchema = TablesSchema,
	TKv extends KvSchema = KvSchema,
> = {
	id: string;
	providerId: string;
	ydoc: Y.Doc;
	tables?: Tables<TTables>;
	kv?: Kv<TKv>;
	paths: ProviderPaths | undefined;

	/**
	 * Require helpers for providers that need specific capabilities.
	 * Throws a clear error if the capability wasn't configured.
	 */
	require: {
		tables(): Tables<TTables>;
		kv(): Kv<TKv>;
	};
};
```

### Phase 5: Update `HandlerContext`

**File: `packages/epicenter/src/core/workspace/contract.ts`**

```typescript
// BEFORE (lines 162-174)
export type HandlerContext<
	TSchema extends WorkspaceSchema = WorkspaceSchema,
	TProviderExports extends Record<string, Providers> = Record<
		string,
		Providers
	>,
> = {
	tables: Tables<TSchema>;
	schema: TSchema;
	validators: WorkspaceValidators<TSchema>;
	providers: TProviderExports;
	paths: WorkspacePaths | undefined;
};

// AFTER
export type HandlerContext<
	TTables extends TablesSchema = TablesSchema,
	TProviderExports extends Record<string, Providers> = Record<
		string,
		Providers
	>,
> = {
	tables: Tables<TTables>;
	validators: WorkspaceValidators<TTables>;
	providers: TProviderExports;
	paths: WorkspacePaths | undefined;
};
```

Note: `schema` removed - access via `tables.{tableName}.schema`.

### Phase 6: Update Provider Implementations

**SQLite Provider (`sqlite-provider.ts`)**

```typescript
// BEFORE (line 89-90)
export const sqliteProvider = (async <TSchema extends WorkspaceSchema>(
  { id, schema, tables, paths }: ProviderContext<TSchema>,

// AFTER
export const sqliteProvider = (async <TTables extends TablesSchema>(
  context: ProviderContext<TTables>,
) => {
  const { id, paths } = context;
  const tables = context.require.tables();

  // BEFORE: convertWorkspaceSchemaToDrizzle(schema)
  // AFTER: Build schema from tables
  const tablesSchema = Object.fromEntries(
    tables.defined().map(table => [table.name, table.schema])
  ) as TTables;
  const drizzleTables = convertWorkspaceSchemaToDrizzle(tablesSchema);
```

**Markdown Provider (`markdown-provider.ts`)**

```typescript
// BEFORE (line 230-234)
export const markdownProvider = (async <TSchema extends WorkspaceSchema>(
  context: ProviderContext<TSchema>,

// AFTER
export const markdownProvider = (async <TTables extends TablesSchema>(
  context: ProviderContext<TTables>,
) => {
  const { id, providerId, paths } = context;
  const tables = context.require.tables();
```

### Phase 7: Update Workspace Contract

**File: `packages/epicenter/src/core/workspace/contract.ts`**

Update all type signatures to use `TTables` instead of `TSchema`:

```typescript
export type WorkspaceContract<
	TId extends string = string,
	TTables extends TablesSchema = TablesSchema,
	TActions extends ActionContracts = ActionContracts,
> = {
	id: TId;
	tables: TTables;
	actions: TActions;
	description?: string;
};
```

### Phase 8: Update Initialization

**File: `packages/epicenter/src/core/workspace/contract.ts`**

Update `initializeWorkspace` to create `require` helpers:

```typescript
async function initializeWorkspace<
  TId extends string,
  TTables extends TablesSchema,
  TProviders extends ProviderMap<TTables>,
>(
  config: WorkspaceContract<TId, TTables, ActionContracts>,
  providerFactories: TProviders,
  options?: CreateOptions,
): Promise<InitializedWorkspace<TTables, TProviders>> {
  // ... existing setup ...

  const tables = createTables(ydoc, config.tables);

  // Create require helpers
  const require = {
    tables: () => {
      if (!tables) {
        throw new Error(
          `Provider requires tables but none were configured for workspace "${config.id}"`
        );
      }
      return tables;
    },
    kv: () => {
      throw new Error(
        `Provider requires kv but none were configured for workspace "${config.id}"`
      );
    },
  };

  // Pass to providers
  const result = await providerFn({
    id: config.id,
    providerId,
    ydoc,
    tables,
    kv: undefined, // KV support to be added later
    paths,
    require,
  });
```

## Files to Modify

### Core Schema Types

- [ ] `packages/epicenter/src/core/schema/fields/types.ts` - Rename WorkspaceSchema, add TablesSchema
- [ ] `packages/epicenter/src/core/schema/index.ts` - Update exports

### Provider Context

- [ ] `packages/epicenter/src/core/provider.shared.ts` - Update ProviderContext type
- [ ] `packages/epicenter/src/core/provider.ts` - Update re-exports
- [ ] `packages/epicenter/src/core/provider.node.ts` - Update re-exports
- [ ] `packages/epicenter/src/core/provider.browser.ts` - Update re-exports

### Workspace Contract

- [ ] `packages/epicenter/src/core/workspace/contract.ts` - Update all types and initialization
- [ ] `packages/epicenter/src/core/workspace/config.shared.ts` - Update types
- [ ] `packages/epicenter/src/core/workspace/config.node.ts` - Update types
- [ ] `packages/epicenter/src/core/workspace/config.browser.ts` - Update types

### Table/DB System

- [ ] `packages/epicenter/src/core/db/core.ts` - Update generic names
- [ ] `packages/epicenter/src/core/db/table-helper.ts` - Update generic names

### Schema Utilities

- [ ] `packages/epicenter/src/core/schema/fields/validators.ts` - Update generic names
- [ ] `packages/epicenter/src/core/schema/fields/to-arktype.ts` - Update generic names
- [ ] `packages/epicenter/src/core/schema/fields/to-arktype-yjs.ts` - Update generic names
- [ ] `packages/epicenter/src/core/schema/fields/to-drizzle.ts` - Update generic names

### Providers

- [ ] `packages/epicenter/src/providers/sqlite/sqlite-provider.ts` - Use new context
- [ ] `packages/epicenter/src/providers/markdown/markdown-provider.ts` - Use new context
- [ ] `packages/epicenter/src/providers/persistence/web.ts` - Use new context
- [ ] `packages/epicenter/src/providers/persistence/desktop.ts` - Use new context
- [ ] `packages/epicenter/src/providers/websocket-sync.ts` - Use new context

### YJS Utilities

- [ ] `packages/epicenter/src/core/utils/yjs.ts` - Update generic names

### Tests

- [ ] `packages/epicenter/src/core/db/core.test.ts` - Update if needed
- [ ] `packages/epicenter/src/core/db/core-types.test.ts` - Update if needed
- [ ] `packages/epicenter/src/core/schema/fields/validators.test.ts` - Update if needed

## Migration Strategy

1. **Add new types first** (non-breaking): Add `TablesSchema` as alias
2. **Update generics** (non-breaking): Rename `TSchema` to `TTables`/`TTableSchema`
3. **Update ProviderContext** (breaking): Remove `schema`, add `require`
4. **Update providers** (breaking): Use new context shape
5. **Add deprecation warnings** for old names
6. **Clean up** after one release cycle

## Testing Plan

1. Run `bun run typecheck` after each phase
2. Run `bun run test` to verify functionality
3. Manually test:
   - SQLite provider initialization
   - Markdown provider initialization
   - Handler context access patterns

## Rollback Plan

If issues arise:

1. Revert to using `schema` property (keep both temporarily)
2. Keep `WorkspaceSchema` as alias for `TablesSchema`
3. Providers can access schema either way during transition

## Review

### Phase 1-3 (Schema Naming) - Completed

Commits:

- `bb35e1a03`: Added `TablesSchema` type alias
- `2bc3c740b`: Renamed `TSchema`/`TWorkspaceSchema` → `TTablesSchema` for workspace-level generics
- `d3c28d99d`: Renamed `TSchema` → `TTableSchema` for single-table generics

### Phase 4 (ProviderContext + KV) - Completed

**Design Decision Change**: Made both `tables` and `kv` **required** (never undefined) instead of optional with `require.*()` helpers. This matches runtime reality and simplifies provider code.

**Changes Made**:

1. **`provider.shared.ts`**:
   - Removed `schema` property from `ProviderContext`
   - Added `kv: Kv<TKvSchema>` property (always present)
   - Added `TKvSchema` generic to `ProviderContext` and `Provider` types

2. **`contract.ts`**:
   - Added `kv?: TKvSchema` to `WorkspaceContract` (optional, defaults to `{}`)
   - Removed `schema` from `HandlerContext`, added `kv`
   - Added `TKvSchema` generic to all relevant types:
     - `Workspace`, `WorkspaceWithProviders`, `WorkspaceContract`
     - `HandlerContext`, `HandlerFn`, `HandlersForContracts`
     - `ProviderMap`, `BoundWorkspaceClient`, `InitializedWorkspace`
   - Updated `initializeWorkspace()` to create KV and pass to providers/handlers
   - Updated `defineWorkspace()` to include KV in all client creation paths

3. **`sqlite-provider.ts`**:
   - Updated generic from `TSchema extends WorkspaceSchema` to `TTablesSchema extends TablesSchema`
   - Removed `schema` from context destructuring
   - Reconstructs schema from tables: `Object.fromEntries(tables.defined().map(t => [t.name, t.schema]))`

4. **`markdown-provider.ts`**:
   - Updated all `WorkspaceSchema` references to `TablesSchema`
   - Renamed `TSchema` generic to `TTablesSchema`

**Type Safety**: All changes typecheck successfully with `bun run typecheck`.
