# Workspace Type Consolidation

**Date**: 2026-01-17
**Status**: Completed
**Related**: `20260117T004421-workspace-input-normalization.md`

## Problem

The workspace normalization system had accumulated duplicate types and unnecessary complexity:

1. **Duplicated normalization logic**: Both `normalize.ts` and `workspace.ts` had their own normalization functions doing the same thing
2. **Unnecessary type aliases**: `TableLike`, `KvLike`, `WorkspaceDefinitionShape` existed only as intermediate types
3. **Confusing naming**: `WorkspaceConfig` vs `WorkspaceDefinition` didn't clearly communicate input vs output
4. **Circular import workarounds**: `WorkspaceDefinitionShape` in `normalize.ts` duplicated `WorkspaceDefinition` to avoid circular imports

## Solution

Consolidated all workspace normalization into `workspace.ts` with clear input→output naming.

### Type Flow (Before)

```
WorkspaceConfig ──┐
                  ├──► normalizeWorkspaceConfig() ──► WorkspaceDefinition
WorkspaceInput ───┘    (in workspace.ts)
       │
       └──► normalizeWorkspace()  ──► WorkspaceDefinitionShape
            (in normalize.ts)          (duplicate of WorkspaceDefinition)
```

### Type Flow (After)

```
WorkspaceInput ──► normalizeWorkspaceInput() ──► WorkspaceDefinition
(accepts either    (single location in           (always full)
minimal or full)   workspace.ts)
```

## Type System Overview

### Naming Convention

| Suffix         | Meaning                                                      | Example                                                  |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| **Schema**     | Raw type constraints, no UI metadata                         | `FieldSchema`, `FieldSchemaMap`, `KvFieldSchema`         |
| **Definition** | Schema + UI metadata (name, icon, description)               | `TableDefinition`, `KvDefinition`, `WorkspaceDefinition` |
| **Input**      | Flexible input that accepts minimal or full, gets normalized | `WorkspaceInput`                                         |

### Complete Type Inventory

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SCHEMA LAYER (raw constraints, no metadata)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FieldSchema          A single field's type definition                      │
│  ├── IdFieldSchema      { type: 'id' }                                      │
│  ├── TextFieldSchema    { type: 'text', nullable?: boolean }                │
│  ├── SelectFieldSchema  { type: 'select', options: [...] }                  │
│  └── ...etc                                                                 │
│                                                                             │
│  FieldSchemaMap       Map of field names to schemas                         │
│                       { id: IdFieldSchema, title: TextFieldSchema, ... }    │
│                                                                             │
│  KvFieldSchema        Any FieldSchema except IdFieldSchema                  │
│                       (KV entries don't have IDs)                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  DEFINITION LAYER (schema + UI metadata)                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TableDefinition      Full table with metadata                              │
│  {                                                                          │
│    name: string;              // Display name ("Blog Posts")                │
│    icon: IconDefinition;      // Emoji or image                             │
│    cover: CoverDefinition;    // Banner image                               │
│    description: string;       // Tooltip/docs                               │
│    fields: FieldSchemaMap;    // The actual schema                          │
│  }                                                                          │
│                                                                             │
│  KvDefinition         Full KV entry with metadata                           │
│  {                                                                          │
│    name: string;              // Display name ("Theme")                     │
│    icon: IconDefinition;      // Emoji or image                             │
│    description: string;       // Tooltip/docs                               │
│    field: KvFieldSchema;      // The actual schema                          │
│  }                                                                          │
│                                                                             │
│  WorkspaceDefinition  Complete workspace (always has all metadata)          │
│  {                                                                          │
│    id: string;                // Identifier                                 │
│    name: string;              // Display name                               │
│    tables: Record<string, TableDefinition>;                                 │
│    kv: Record<string, KvDefinition>;                                        │
│  }                                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  INPUT LAYER (flexible, accepts minimal or full)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WorkspaceInput       What developers write in defineWorkspace()            │
│  {                                                                          │
│    id: string;                // Required                                   │
│    name?: string;             // Optional (derived from id if omitted)      │
│    tables: Record<string,                                                   │
│      FieldSchemaMap |         // Minimal: just fields                       │
│      TableDefinition          // Full: fields + metadata                    │
│    >;                                                                       │
│    kv: Record<string,                                                       │
│      KvFieldSchema |          // Minimal: just field                        │
│      KvDefinition             // Full: field + metadata                     │
│    >;                                                                       │
│  }                                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  TYPE-LEVEL NORMALIZATION (for TypeScript inference)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  NormalizedTables<T>  Transforms input table map to definition map          │
│                                                                             │
│    Input:  { posts: { id: id(), title: text() } }        (FieldSchemaMap)   │
│    Output: { posts: TableDefinition<{ id: ..., title: ... }> }              │
│                                                                             │
│  NormalizedKv<T>      Transforms input KV map to definition map             │
│                                                                             │
│    Input:  { theme: select({ options: ['light', 'dark'] }) }                │
│    Output: { theme: KvDefinition<SelectFieldSchema<...>> }                  │
│                                                                             │
│  These exist so TypeScript knows the OUTPUT type after normalization.       │
│  Without them, workspace.tables.posts wouldn't have the right type.         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Normalization Flow

```
                    ┌─────────────────────────────────────────┐
                    │            WorkspaceInput               │
                    │  (what developers write)                │
                    │                                         │
                    │  {                                      │
                    │    id: 'epicenter.blog',                │
                    │    tables: {                            │
                    │      posts: { id: id(), title: text() } │  ← FieldSchemaMap
                    │    },                                   │
                    │    kv: {}                               │
                    │  }                                      │
                    └────────────────┬────────────────────────┘
                                     │
                                     │  defineWorkspace()
                                     │  └── normalizeWorkspaceInput()
                                     │
                    ┌────────────────▼────────────────────────┐
                    │          WorkspaceDefinition            │
                    │  (canonical form, always complete)      │
                    │                                         │
                    │  {                                      │
                    │    id: 'epicenter.blog',                │
                    │    name: 'Epicenter blog',        ← derived from id
                    │    tables: {                            │
                    │      posts: {                           │
                    │        name: 'Posts',             ← derived from key
                    │        icon: { type: 'emoji', value: '📄' },
                    │        cover: null,                     │
                    │        description: '',                 │
                    │        fields: { id: ..., title: ... }  │
                    │      }                                  │  ← TableDefinition
                    │    },                                   │
                    │    kv: {}                               │
                    │  }                                      │
                    └────────────────┬────────────────────────┘
                                     │
                                     │  .create()
                                     │
                    ┌────────────────▼────────────────────────┐
                    │           WorkspaceClient               │
                    │  (runtime, with Y.Doc and helpers)      │
                    └─────────────────────────────────────────┘
```

## Detection Logic

How `normalizeWorkspaceInput()` determines if a table/kv entry is minimal or full:

```typescript
// Tables: TableDefinition has 'fields', FieldSchemaMap doesn't
'fields' in value ? (value as TableDefinition) : normalizeTable(key, value);

// KV: KvDefinition has 'field', KvFieldSchema doesn't
'field' in value ? (value as KvDefinition) : normalizeKv(key, value);
```

## Files Changed

### `packages/epicenter/src/core/workspace/normalize.ts`

**Before**: Contained full `normalizeWorkspace()` function, `WorkspaceInput`, `TableInput`, `KvInput`, `WorkspaceDefinitionShape` types, and `isWorkspaceDefinition` type guard.

**After**: Minimal file with only:

- `DEFAULT_TABLE_ICON`, `DEFAULT_KV_ICON` constants
- `isTableDefinition()`, `isKvDefinition()` type guards
- `normalizeTable()`, `normalizeKv()` atomic normalizers

### `packages/epicenter/src/core/workspace/workspace.ts`

**Before**: Had `WorkspaceConfig`, `WorkspaceInputConfig`, `TableLike`, `KvLike`, `normalizeWorkspaceConfig()`, and two function overloads for `defineWorkspace`.

**After**: Single source of truth with:

- `WorkspaceInput` type (flexible input)
- `NormalizedTables`, `NormalizedKv` type utilities
- `normalizeWorkspaceInput()` function
- Single `defineWorkspace()` signature with `const` generics

### `packages/epicenter/src/core/workspace/node.ts`

Updated to import new types and use `WorkspaceInput` instead of `WorkspaceConfig`.

### `packages/epicenter/src/core/workspace/index.ts`

Updated exports:

- Removed: `TableLike`, `KvLike`, `WorkspaceConfig`, `isWorkspaceDefinition`, `normalizeWorkspace`
- Added: `WorkspaceInput`
- Kept: `NormalizedTables`, `NormalizedKv` (for advanced users)

### `packages/epicenter/src/index.ts`

Same export changes as workspace/index.ts.

## Default Values Applied During Normalization

| Field               | Default Value                    |
| ------------------- | -------------------------------- |
| Workspace `name`    | `humanizeString(id)`             |
| Table `name`        | `humanizeString(key)`            |
| Table `icon`        | `{ type: 'emoji', value: '📄' }` |
| Table `cover`       | `null`                           |
| Table `description` | `''`                             |
| KV `name`           | `humanizeString(key)`            |
| KV `icon`           | `{ type: 'emoji', value: '⚙️' }` |
| KV `description`    | `''`                             |

## Usage Examples

### Minimal Input (Most Common)

```typescript
const workspace = defineWorkspace({
	id: 'epicenter.blog',
	tables: {
		posts: { id: id(), title: text(), published: boolean({ default: false }) },
		authors: { id: id(), name: text(), email: text() },
	},
	kv: {
		theme: select({ options: ['light', 'dark'] as const, default: 'light' }),
	},
});

// Result:
// workspace.name === 'Epicenter blog'
// workspace.tables.posts.name === 'Posts'
// workspace.tables.posts.icon === { type: 'emoji', value: '📄' }
// workspace.kv.theme.name === 'Theme'
```

### Full Input (When You Need Custom Metadata)

```typescript
const workspace = defineWorkspace({
	id: 'epicenter.blog',
	name: 'My Blog',
	tables: {
		posts: {
			name: 'Blog Posts',
			icon: { type: 'emoji', value: '📝' },
			cover: null,
			description: 'All published and draft blog posts',
			fields: {
				id: id(),
				title: text(),
				published: boolean({ default: false }),
			},
		},
	},
	kv: {
		theme: {
			name: 'Color Theme',
			icon: { type: 'emoji', value: '🎨' },
			description: 'Application color scheme',
			field: select({ options: ['light', 'dark'] as const, default: 'light' }),
		},
	},
});
```

### Mixed Input (Per-Table Choice)

```typescript
const workspace = defineWorkspace({
	id: 'epicenter.blog',
	name: 'My Blog', // Explicit name
	tables: {
		// Full definition for important table
		posts: {
			name: 'Blog Posts',
			icon: { type: 'emoji', value: '📝' },
			cover: null,
			description: 'All blog posts',
			fields: { id: id(), title: text() },
		},
		// Minimal for internal table (defaults applied)
		drafts: { id: id(), content: text() },
	},
	kv: {},
});
```

## Why NormalizedTables/NormalizedKv Exist

These are **type-level transformations** that tell TypeScript what the output type will be. Without them:

```typescript
// WITHOUT type-level normalization:
const workspace = defineWorkspace({
	tables: { posts: { id: id(), title: text() } },
});
// TypeScript thinks: workspace.tables.posts is FieldSchemaMap
// But we need: workspace.tables.posts is TableDefinition<...>

// WITH NormalizedTables<T>:
// TypeScript correctly infers: workspace.tables.posts is TableDefinition<{ id: ..., title: ... }>
```

They're the type-level equivalent of what `normalizeWorkspaceInput()` does at runtime.

## Breaking Changes

The following exports were removed (internal implementation details):

- `TableLike`, `KvLike` (inlined into `WorkspaceInput`)
- `WorkspaceConfig` (renamed to `WorkspaceInput`)
- `isWorkspaceDefinition` (no longer needed externally)
- `normalizeWorkspace` (replaced by internal `normalizeWorkspaceInput`)

If any external code used these, update as follows:

- `WorkspaceConfig` → `WorkspaceInput`
- `TableLike` → `FieldSchemaMap | TableDefinition`
- `KvLike` → `KvFieldSchema | KvDefinition`
