# Notion-like Schema Refactor

## Problem Statement

Current Epicenter schema has metadata in the wrong places compared to Notion:

| Level     | Current Epicenter      | Notion                              | Issue     |
| --------- | ---------------------- | ----------------------------------- | --------- |
| Workspace | Has emoji, description | Nothing (just container)            | Backwards |
| Table     | Nothing                | Has icon, cover, description, title | Missing   |
| Field     | Nothing                | Has name, description               | Missing   |

Users can't properly document their tables or fields. SQLite queries use ugly keys instead of readable names.

## Goals

1. Align with Notion's proven data model
2. Make SQLite queries human-readable
3. Force documentation through required metadata
4. Maintain forward compatibility for future features

---

## Type Definitions

### IconDefinition (Forward Compatible)

```typescript
type IconDefinition =
	| { type: 'emoji'; value: string }
	| { type: 'external'; url: string };
// Future: | { type: 'lucide'; name: string }
```

### CoverDefinition (Forward Compatible)

```typescript
type CoverDefinition = { type: 'external'; url: string };
// Future: | { type: 'gradient'; colors: string[] }
// Future: | { type: 'unsplash'; id: string }
```

### WorkspaceSchema (Updated)

```typescript
type WorkspaceSchema<
	TId extends string = string,
	TTablesSchema extends TablesWithMetadata = TablesWithMetadata,
	TKvSchema extends KvSchema = KvSchema,
> = {
	guid: string; // Sync coordination
	id: TId; // URL/code slug
	name: string; // Display name
	// REMOVED: emoji
	// REMOVED: description
	tables: TTablesSchema;
	kv: TKvSchema;
};
```

### TableDefinition (New)

```typescript
type TableDefinition<TFields extends FieldDefinitions = FieldDefinitions> = {
	name: string; // Required - "Blog Posts"
	icon: IconDefinition | null; // Required - emoji or image
	cover: CoverDefinition | null; // Required - banner image
	description: string; // Required - "All blog posts"
	fields: TFields; // The schema
};

type TablesWithMetadata = Record<string, TableDefinition>;
```

### FieldDefinition (Updated)

All field types gain optional `name` and `description`:

```typescript
type TextFieldSchema<TNullable extends boolean = boolean> = {
	type: 'text';
	name?: string; // Optional - defaults to capitalized key
	description?: string; // Optional - defaults to ''
	nullable?: TNullable;
	default?: string;
};

// Same pattern applies to ALL field types:
// - IdFieldSchema
// - IntegerFieldSchema
// - RealFieldSchema
// - BooleanFieldSchema
// - DateFieldSchema
// - SelectFieldSchema
// - TagsFieldSchema
// - JsonFieldSchema
// - RichtextFieldSchema
```

---

## Before/After Examples

### Before (Current)

```typescript
const workspace: WorkspaceSchema = {
	guid: 'abc-123',
	id: 'blog',
	name: 'My Blog',
	emoji: '📝', // Wrong place
	description: 'A blog', // Wrong place
	tables: {
		posts: {
			// No metadata
			id: { type: 'id' },
			title: { type: 'text' },
			author_id: { type: 'text' },
		},
	},
	kv: {},
};

// SQLite columns: id, title, author_id (ugly)
```

### After (Notion-like)

```typescript
const workspace: WorkspaceSchema = {
	guid: 'abc-123',
	id: 'blog',
	name: 'My Blog',
	// No emoji, no description
	tables: {
		posts: {
			name: 'Blog Posts',
			icon: { type: 'emoji', value: '📝' },
			cover: null,
			description: 'All blog posts and drafts',
			fields: {
				id: {
					type: 'id',
					name: 'ID',
					description: 'Unique identifier',
				},
				title: {
					type: 'text',
					name: 'Title',
					description: 'Post headline',
				},
				author_id: {
					type: 'text',
					name: 'Author',
					description: 'Who wrote this',
				},
			},
		},
	},
	kv: {},
};

// SQLite columns: id, title, author (readable!)
```

---

## SQLite Column Naming

### Key Insight

SQLite in Epicenter is **ephemeral**. It's rebuilt on every debounce. No migrations needed. Column names can change freely.

### Decision

Use `snake_case(field.name)` for SQL columns, NOT field keys.

```
Field Key        Field Name      SQL Column
─────────────────────────────────────────────
author_id    →   "Author"    →   author
created_at   →   "Created"   →   created
is_published →   "Published" →   published
post_title   →   "Title"     →   title
```

### Conversion Function

Use `@sindresorhus/slugify` with underscore separator:

```typescript
import slugify from '@sindresorhus/slugify';

function toSqlIdentifier(displayName: string): string {
	return slugify(displayName, { separator: '_' });
}

// Examples:
// "Blog Posts"  → "blog_posts"
// "Author"      → "author"
// "Published?"  → "published"
// "Created At"  → "created_at"
// "Title"       → "title"
// "BAR and baz" → "bar_and_baz"
```

Why `slugify`:

- Battle-tested by sindresorhus
- Handles unicode, special chars, edge cases
- Same author as `filenamify` (consistent API philosophy)

### Result

Users can write readable SQL:

```sql
-- After (readable)
SELECT author, title, created
FROM blog_posts
WHERE published = true;

-- Before (ugly)
SELECT author_id, post_title, created_at
FROM posts
WHERE is_published = true;
```

---

## Key Decisions

| Question                    | Decision                | Rationale                   |
| --------------------------- | ----------------------- | --------------------------- |
| Keys editable?              | **No**                  | Code references would break |
| Cover images?               | **Yes, nullable**       | Forward compatible          |
| Field name required?        | **No (optional)**       | Derive from key if missing  |
| Field description required? | **No (optional)**       | Empty string if missing     |
| Table metadata required?    | **Yes**                 | UI always has values        |
| Icon format?                | **Discriminated union** | Extensible                  |
| SQLite columns?             | **snake_case(name)**    | Human readable              |

---

## Files to Change

### Core Schema Types

`packages/epicenter/src/core/schema/fields/types.ts`

- Add `name: string` and `description: string` to all field schema types
- Update `TableDefinition` type with full metadata
- Add `IconDefinition` and `CoverDefinition` types

### Factory Functions

`packages/epicenter/src/core/schema/fields/factories.ts`

- Update all factories to require `name` and `description`
- Add `defineTable()` helper that enforces metadata

### Workspace Contract

`packages/epicenter/src/core/workspace/contract.ts`

- Remove `emoji` and `description` from `WorkspaceSchema`

### SQLite Converter

`packages/epicenter/src/core/schema/converters/to-drizzle.ts`

- Add `toSqlIdentifier()` function
- Use `toSqlIdentifier(field.name)` for column names
- Use `toSqlIdentifier(table.name)` for table names

### Epicenter App

`apps/epicenter/src/lib/services/workspace-storage.ts`

- Update type handling for new schema

`apps/epicenter/src/lib/query/workspaces.ts`

- Update `createWorkspace` mutation
- Update `addTable` mutation to create proper `TableDefinition`

## Implementation Order

- [ ] 1. Update type definitions in `types.ts` (IconDefinition, CoverDefinition, field name/description)
- [ ] 2. Update factory functions in `factories.ts`
- [ ] 3. Remove emoji/description from `WorkspaceSchema` in `contract.ts`
- [ ] 4. Add slugify dependency and update SQLite converter
- [ ] 5. Update epicenter app mutations

---

## Summary

This refactor:

1. **Moves metadata** from workspace → tables/fields (Notion-like)
2. **Requires documentation** via mandatory name/description
3. **Makes SQL readable** by using display names for columns
4. **Stays extensible** via discriminated union types
5. **Keys remain stable** for code references
