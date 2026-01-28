# Branded Types with Constructor Functions

Branded types (also called nominal types or tagged types) add type safety to primitive values. A `UserId` is not interchangeable with a `PostId`, even though both are strings at runtime.

The problem: TypeScript's structural typing means you need type assertions (`as UserId`) to create branded values. These assertions scattered throughout a codebase become maintenance nightmares.

The solution: **Brand constructor functions** - a single function that creates branded values, containing the only type assertion in the codebase.

## The Pattern

```typescript
import type { Brand } from 'wellcrafted/brand';

// 1. Define the branded type
export type RowId = string & Brand<'RowId'>;

// 2. Create the brand constructor
export function rowId(id: string): RowId {
  return id as RowId;
}
```

That's it. The `rowId()` function is the only place in the entire codebase that uses `as RowId`.

## Why This Matters

### Before: Scattered Assertions

```typescript
// user-service.ts
const userId = data.id as UserId;

// post-service.ts
function getPost(id: string) {
  return db.posts.get(id as PostId);
}

// api-handler.ts
const parsed = params.userId as UserId;

// component.ts
onClick={() => deleteUser(selectedId as UserId)}
```

Problems:
- **No single point of control** - assertions everywhere
- **Hard to add validation** - would need to change dozens of files
- **Invisible boundaries** - can't see where branding happens
- **Refactoring risk** - miss one spot and you have a bug

### After: Brand Constructors

```typescript
// user-service.ts
const userId = userId(data.id);

// post-service.ts
function getPost(id: string) {
  return db.posts.get(postId(id));
}

// api-handler.ts
const parsed = userId(params.userId);

// component.ts
onClick={() => deleteUser(userId(selectedId))}
```

Benefits:
- **One assertion** - only in the constructor function
- **Easy to add validation** - change one function
- **Explicit boundaries** - `userId()` calls mark branding points
- **Searchable** - find all branding with `userId(`

## Adding Validation Later

The constructor is the perfect place to add runtime checks:

```typescript
export function rowId(id: string): RowId {
  if (id.includes(':')) {
    throw new Error(`RowId cannot contain ':' separator: "${id}"`);
  }
  if (id.length === 0) {
    throw new Error('RowId cannot be empty');
  }
  return id as RowId;
}
```

Every `rowId()` call in the codebase now validates automatically.

## Real Example: Cell Keys

In our cell workspace, we have `RowId` and `FieldId` branded types that combine into cell keys:

```typescript
// keys.ts
export type RowId = string & Brand<'RowId'>;
export type FieldId = string & Brand<'FieldId'>;
export type CellKey = `${RowId}:${FieldId}`;

// Brand constructors - only assertions in codebase
export function rowId(id: string): RowId {
  return id as RowId;
}

export function fieldId(id: string): FieldId {
  return id as FieldId;
}

// Functions require branded types
export function cellKey(row: RowId, field: FieldId): CellKey {
  return `${row}:${field}` as CellKey;
}

// Parsing returns branded types
export function parseCellKey(key: string): { rowId: RowId; fieldId: FieldId } {
  const [row, field] = key.split(':');
  return { rowId: rowId(row), fieldId: fieldId(field) };
}
```

Callers are explicit about branding:

```typescript
// Clear where strings become branded
const row = rowId(userInput);
const field = fieldId('title');
const key = cellKey(row, field);

// Or inline for simple cases
store.set(cellKey(rowId(id), fieldId('status')), 'active');
```

## Naming Convention

| Branded Type | Constructor |
|--------------|-------------|
| `RowId` | `rowId()` |
| `FieldId` | `fieldId()` |
| `UserId` | `userId()` |
| `WorkspaceGuid` | `workspaceGuid()` |

The constructor is the **lowercase camelCase** version of the type.

## Parameter Shadowing

When a function parameter has the same name as the brand constructor, rename the parameter:

```typescript
// Bad: `rowId` parameter shadows the constructor
function getRow(rowId: string) {
  return store.get(rowId(rowId));  // Error: rowId is not a function
}

// Good: rename parameter to avoid shadowing
function getRow(row: string) {
  return store.get(rowId(row));  // Works!
}
```

## When to Use Branded Types

Good candidates:
- **IDs** - user IDs, post IDs, row IDs
- **Keys** - cache keys, storage keys
- **Paths** - file paths, URL paths
- **Tokens** - auth tokens, API keys

Not worth it for:
- Values only used in one place
- Types that already have rich structure (objects, classes)
- When the type system already distinguishes them

## The wellcrafted/brand Package

We use `Brand` from `wellcrafted/brand`:

```typescript
import type { Brand } from 'wellcrafted/brand';

type UserId = string & Brand<'UserId'>;
```

This creates a unique symbol-based brand that TypeScript tracks, preventing accidental mixing of branded types.

## Summary

1. **Define the type**: `type RowId = string & Brand<'RowId'>`
2. **Create the constructor**: `function rowId(s: string): RowId { return s as RowId }`
3. **Never use `as RowId` anywhere else**
4. **Call the constructor** at branding boundaries

The constructor is the gatekeeper. All strings must pass through it to become branded. This gives you one place to add validation, logging, or any other cross-cutting concern.
