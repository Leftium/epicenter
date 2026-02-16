---
name: static-workspace-api
description: Static workspace API patterns for defineTable, defineKv, versioning, and migrations. Use when defining workspace schemas, adding versions to existing tables/KV stores, or writing migration functions.
metadata:
  author: epicenter
  version: '2.0'
---

# Static Workspace API

Type-safe schema definitions for tables and KV stores with versioned migrations.

## When to Apply This Skill

- Defining a new table or KV store with `defineTable()` or `defineKv()`
- Adding a new version to an existing definition
- Writing migration functions
- Converting from shorthand to builder pattern

## Tables

### Shorthand (Single Version)

Use when a table has only one version:

```typescript
import { defineTable } from 'epicenter/static';
import { type } from 'arktype';

const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
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

KV stores are flexible — `_v` is optional. Both patterns work:

### Without `_v` (field presence)

```typescript
import { defineKv } from 'epicenter/static';

const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));

// Multi-version with field presence
const theme = defineKv()
	.version(type({ mode: "'light' | 'dark'" }))
	.version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }))
	.migrate((v) => {
		if (!('fontSize' in v)) return { ...v, fontSize: 14 };
		return v;
	});
```

### With `_v` (explicit discriminant)

```typescript
const theme = defineKv()
	.version(type({ mode: "'light' | 'dark'", _v: '1' }))
	.version(
		type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }),
	)
	.migrate((v) => {
		switch (v._v) {
			case 1:
				return { ...v, fontSize: 14, _v: 2 };
			case 2:
				return v;
		}
	});
```

## The `_v` Convention

- `_v` is a **number** discriminant field (`'1'` in arktype = the literal number `1`)
- **Required for tables** — enforced at the type level via `CombinedStandardSchema<{ id: string; _v: number }>`
- **Optional for KV stores** — KV keeps full flexibility
- In arktype schemas: `_v: '1'`, `_v: '2'`, `_v: '3'` (number literals)
- In migration returns: `_v: 2` (TypeScript narrows automatically, `as const` is unnecessary)
- Convention: `_v` goes last in the object (`{ id, ...fields, _v: '1' }`)

## Migration Function Rules

1. Input type is a union of all version outputs
2. Return type is the latest version output
3. Use `switch (row._v)` for discrimination (tables always have `_v`)
4. Final case returns `row` as-is (already latest)
5. Always migrate directly to latest (not incrementally through each version)

## Anti-Patterns

### Incremental migration (v1 -> v2 -> v3)

```typescript
// BAD: Chains through each version
.migrate((row) => {
  let current = row;
  if (current._v === 1) current = { ...current, views: 0, _v: 2 };
  if (current._v === 2) current = { ...current, tags: [], _v: 3 };
  return current;
})

// GOOD: Migrate directly to latest
.migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, tags: [], _v: 3 };
    case 2: return { ...row, tags: [], _v: 3 };
    case 3: return row;
  }
})
```

### Note: `as const` is unnecessary

TypeScript contextually narrows `_v: 2` to the literal type based on the return type constraint. Both of these work:

```typescript
return { ...row, views: 0, _v: 2 }; // Works — contextual narrowing
return { ...row, views: 0, _v: 2 as const }; // Also works — redundant
```

## References

- `packages/epicenter/src/static/define-table.ts`
- `packages/epicenter/src/static/define-kv.ts`
- `packages/epicenter/src/static/index.ts`
- `packages/epicenter/src/static/create-tables.ts`
- `packages/epicenter/src/static/create-kv.ts`
