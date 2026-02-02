# Tables With Metadata Only Migration

**Date**: 2026-01-09
**Status**: In Progress
**Breaking Change**: Yes

## Summary

Remove support for the simple `TablesSchema` format and require all table definitions to use the full `TablesWithMetadata` format with explicit metadata (name, icon, cover, description, fields).

## Motivation

Currently `defineWorkspace` accepts two formats for tables:

```typescript
// Simple format (TablesSchema) - what everyone uses
tables: {
  posts: { id: id(), title: text() }
}

// Full format (TablesWithMetadata) - what nobody uses
tables: {
  posts: {
    name: 'Posts',
    icon: { type: 'emoji', value: '📝' },
    cover: null,
    description: 'Blog posts',
    fields: { id: id(), title: text() }
  }
}
```

Problems with current approach:

1. `isTableDefinition()` runtime check adds complexity
2. Metadata is synthesized implicitly, hiding what's actually stored
3. Two ways to do the same thing creates confusion
4. `defineTable()` helper exists but is never used

## Changes

### 1. Remove `defineTable` function

```typescript
// DELETE from factories.ts
export function defineTable<const TFields extends FieldsSchema>(
	definition: TableDefinition<TFields>,
): TableDefinition<TFields> {
	return definition;
}
```

### 2. Update `WorkspaceSchema` type

```typescript
// Before
export type WorkspaceSchema<
  TTablesSchema extends TablesSchema | TablesWithMetadata = TablesSchema | TablesWithMetadata,
  ...
> = {
  tables: TTablesSchema;
  ...
};

// After
export type WorkspaceSchema<
  TTablesSchema extends TablesWithMetadata = TablesWithMetadata,
  ...
> = {
  tables: TTablesSchema;
  ...
};
```

### 3. Update all capabilities

Change `TablesSchema` references to use field extraction from `TablesWithMetadata`:

```typescript
// New helper type (if needed)
type ExtractFieldsSchema<T extends TablesWithMetadata> = {
	[K in keyof T]: T[K]['fields'];
};
```

### 4. Remove `isTableDefinition` check

```typescript
// DELETE from contract.ts
function isTableDefinition(
	value: Record<string, FieldSchema> | TableDefinition,
): value is TableDefinition {
	return 'fields' in value && typeof value.fields === 'object';
}

// Simplify mergeSchemaIntoYDoc - no longer needs the check
```

### 5. Update all call sites

Every `defineWorkspace` call needs updating:

```typescript
// Before
defineWorkspace({
	tables: {
		emails: {
			id: id(),
			sender: text(),
		},
	},
});

// After
defineWorkspace({
	tables: {
		emails: {
			name: 'Emails',
			icon: null,
			cover: null,
			description: '',
			fields: {
				id: id(),
				sender: text(),
			},
		},
	},
});
```

## Files to Update

### Core Types

- [ ] `packages/epicenter/src/core/schema/fields/types.ts` - Consider deprecating `TablesSchema`
- [ ] `packages/epicenter/src/core/schema/fields/factories.ts` - Remove `defineTable`
- [ ] `packages/epicenter/src/core/schema/index.ts` - Update exports
- [ ] `packages/epicenter/src/core/workspace/contract.ts` - Update types, remove `isTableDefinition`
- [ ] `packages/epicenter/src/index.ts` - Update exports

### Capabilities (update generic constraints)

- [ ] `packages/epicenter/src/core/capability.ts`
- [ ] `packages/epicenter/src/core/tables/create-tables.ts`
- [ ] `packages/epicenter/src/core/tables/table-helper.ts`
- [ ] `packages/epicenter/src/capabilities/persistence/web.ts`
- [ ] `packages/epicenter/src/capabilities/persistence/desktop.ts`
- [ ] `packages/epicenter/src/capabilities/websocket-sync.ts`
- [ ] `packages/epicenter/src/capabilities/sqlite/sqlite.ts`
- [ ] `packages/epicenter/src/capabilities/markdown/markdown.ts`

### Call Sites

- [ ] `apps/tab-manager/src/entrypoints/background.ts`
- [ ] `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`
- [ ] `packages/epicenter/scripts/email-minimal-simulation.ts`
- [ ] `packages/epicenter/scripts/email-storage-simulation.ts`
- [ ] `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts`
- [ ] All files in `examples/`

## Future Considerations

- Rename `TablesWithMetadata` to something cleaner like `TablesConfig` or just keep using it through `TableDefinition`
- Consider making metadata fields optional with defaults (less breaking but different trade-offs)

## Migration Guide

For users upgrading:

```typescript
// 1. Wrap each table in the full format
// Before:
tables: {
  posts: { id: id(), title: text() }
}

// After:
tables: {
  posts: {
    name: 'Posts',        // Display name for UI
    icon: null,           // Or { type: 'emoji', value: '📝' }
    cover: null,          // Or { type: 'external', url: '...' }
    description: '',      // Description for docs/tooltips
    fields: { id: id(), title: text() }
  }
}
```
