---
name: workspace-api
description: Workspace API patterns for defineTable, defineKv, versioning, migrations, and data access (CRUD + observation). Use when the user mentions workspace, defineTable, defineKv, createWorkspace, or when defining schemas, reading/writing table data, observing changes, or writing migrations.
metadata:
  author: epicenter
  version: '5.0'
---

# Workspace API

## Reference Repositories

- [Yjs](https://github.com/yjs/yjs) — CRDT framework (foundation of workspace data layer)

Type-safe schema definitions for tables and KV stores.

> **Related Skills**: See `yjs` for Yjs CRDT patterns and shared types. See `svelte` for reactive wrappers (`fromTable`, `fromKv`).

## When to Apply This Skill

- Defining a new table or KV store with `defineTable()` or `defineKv()`
- Adding a new version to an existing table definition
- Writing table migration functions
- Reading, writing, or observing table/KV data

## Tables

### Shorthand (Single Version)

Use when a table has only one version:

```typescript
import { defineTable } from '@epicenter/workspace';
import { type } from 'arktype';

const usersTable = defineTable(type({ id: UserId, email: 'string', _v: '1' }));
export type User = InferTableRow<typeof usersTable>;
```

Every table schema must include `_v` with a number literal. The type system enforces this — passing a schema without `_v` to `defineTable()` is a compile error.

### Builder (Multiple Versions)

Use when you need to evolve a schema over time:

```typescript
const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '1' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
	.migrate((row) => {
		switch (row._v) {
			case 1:
				return { ...row, views: 0, _v: 2 };
			case 2:
				return row;
		}
	});
```

## KV Stores

KV stores use `defineKv(schema, defaultValue)`. No versioning, no migration—invalid stored data falls back to the default.

```typescript
import { defineKv } from '@epicenter/workspace';
import { type } from 'arktype';

const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }), { collapsed: false, width: 300 });
const fontSize = defineKv(type('number'), 14);
const enabled = defineKv(type('boolean'), true);
```

### KV Design Convention: One Scalar Per Key

Use dot-namespaced keys for logical groupings of scalar values:

```typescript
// ✅ Correct — each preference is an independent scalar
'theme.mode': defineKv(type("'light' | 'dark' | 'system'"), 'light'),
'theme.fontSize': defineKv(type('number'), 14),

// ❌ Wrong — structured object invites migration needs
'theme': defineKv(type({ mode: "'light' | 'dark'", fontSize: 'number' }), { mode: 'light', fontSize: 14 }),
```

With scalar values, schema changes either don't break validation (widening `'light' | 'dark'` to `'light' | 'dark' | 'system'` still validates old data) or the default fallback is acceptable (resetting a toggle takes one click).

Exception: discriminated unions and `Record<string, T> | null` are acceptable when they represent a single atomic value.

## Branded Table IDs (Required)

Every table's `id` field and every string foreign key field MUST use a branded type instead of plain `'string'`. This prevents accidental mixing of IDs from different tables at compile time.

### Pattern

Define a branded type + arktype validator + generator in the same file as the workspace definition:

```typescript
import type { Brand } from 'wellcrafted/brand';
import { type } from 'arktype';
import { generateId, type Id } from '@epicenter/workspace';

// 1. Branded type + arktype validator (co-located with workspace definition)
export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();

// 2. Generator function — the ONLY place with the cast
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

// 3. Use in defineTable + co-locate type export
const conversationsTable = defineTable(
	type({
		id: ConversationId,              // Primary key — branded
		title: 'string',
		'parentId?': ConversationId.or('undefined'),  // Self-referencing FK
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

// 4. At call sites — use the generator, never cast directly
const newId = generateConversationId();  // Good
// const newId = generateId() as string as ConversationId;  // Bad
```

## Workspace File Structure

A workspace file has two layers:

1. **Table definitions with co-located types** — `defineTable(schema)` as standalone consts, each immediately followed by `export type = InferTableRow<typeof table>`
2. **`createWorkspace(defineWorkspace({...}))` call** — composes pre-built tables into the client

## The `_v` Convention

- `_v` is a **number** discriminant field (`'1'` in arktype = the literal number `1`)
- **Required for tables** — enforced at the type level via `CombinedStandardSchema<{ id: string; _v: number }>`
- **Not used by KV stores** — KV has no versioning; `defineKv(schema, defaultValue)` is the only pattern
- In arktype schemas: `_v: '1'`, `_v: '2'`, `_v: '3'` (number literals)
- In migration returns: `_v: 2` (TypeScript narrows automatically, `as const` is unnecessary)
- Convention: `_v` goes last in the object (`{ id, ...fields, _v: '1' }`)

## References

Load these on demand based on what you're working on:

- If working with **table migrations** (migration function rules, direct-to-latest strategy, migration anti-patterns, `as const` note), read [references/table-migrations.md](references/table-migrations.md)
- If working with **table/KV CRUD or observation** (`get`, `set`, `update`, `observe`, Svelte observer guidance), read [references/table-kv-crud-observation.md](references/table-kv-crud-observation.md)
- If working with **document content APIs** (`withDocument`, `handle.read/write`, mode bindings, `handle.batch`, `handle.ydoc` anti-pattern), read [references/document-content.md](references/document-content.md)

Code references:

- `packages/workspace/src/workspace/define-table.ts`
- `packages/workspace/src/workspace/define-kv.ts`
- `packages/workspace/src/workspace/index.ts`
- `packages/workspace/src/workspace/create-tables.ts`
- `packages/workspace/src/workspace/create-kv.ts`
