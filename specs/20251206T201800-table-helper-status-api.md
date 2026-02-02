# Table Helper Status-Based API Redesign

## Context

The current `get()` method returns `Result<TRow, RowValidationError> | null` using wellcrafted's Result type which has `{ data, error }` shape. This has a few issues:

1. `null` for "not found" is inconsistent with the object-based Result type
2. The `{ data, error }` discriminant is less domain-specific than `{ status: 'valid' | 'invalid' }`
3. `getAll()` currently only returns valid rows, silently skipping invalid ones

## Goals

1. Use a status-based discriminated union instead of Result types for read operations
2. Make all three states explicit: `valid`, `invalid`, `not_found`
3. Provide both combined (`getAll`) and filtered (`getAllValid`, `getAllInvalid`) methods

## New Types

```typescript
/**
 * Result of getting a single row by ID.
 */
export type GetResult<TRow> =
  | { status: 'valid'; row: TRow }
  | { status: 'invalid'; id: string; error: RowValidationError }
  | { status: 'not_found'; id: string };

/**
 * Result of getting a row from iteration (getAll).
 * Does not include 'not_found' since we're iterating existing rows.
 */
export type RowResult<TRow> =
  | { status: 'valid'; row: TRow }
  | { status: 'invalid'; id: string; error: RowValidationError };
```

## API Changes

### get({ id })

**Before:**
```typescript
get({ id }): Result<TRow, RowValidationError> | null
```

**After:**
```typescript
get({ id }): GetResult<TRow>
```

### getAll() / getAllValid() / getAllInvalid()

**Before:**
- `getAll()` returns `TRow[]` (only valid rows)
- `getAllInvalid()` returns `RowValidationError[]`

**After:**
- `getAll()` returns `RowResult<TRow>[]` (both valid and invalid)
- `getAllValid()` returns `TRow[]` (only valid rows - what `getAll` used to do)
- `getAllInvalid()` returns `RowValidationError[]` (unchanged)

## Usage Examples

```typescript
// Get single row
const result = db.posts.get({ id: '123' });
switch (result.status) {
  case 'valid':
    console.log(result.row.title);
    break;
  case 'invalid':
    console.log('Validation failed:', result.error.context.summary);
    break;
  case 'not_found':
    console.log('Not found:', result.id);
    break;
}

// Get all rows (both valid and invalid)
const all = db.posts.getAll();
for (const item of all) {
  if (item.status === 'valid') {
    console.log(item.row.title);
  } else {
    console.log('Invalid row:', item.id);
  }
}

// Just valid rows (common case)
const posts = db.posts.getAllValid();

// Just invalid rows (for migration/debugging)
const errors = db.posts.getAllInvalid();
```

## Implementation Tasks

- [x] Add `GetResult` and `RowResult` types to table-helper.ts
- [x] Update `get()` method to return `GetResult<TRow>`
- [x] Rename current `getAll()` to `getAllValid()`
- [x] Create new `getAll()` returning `RowResult<TRow>[]`
- [x] Update all usages of `get()` across codebase
- [x] Update all usages of `getAll()` to `getAllValid()` where needed
- [x] Update exports in index.ts
- [x] Update README documentation
- [x] Run type check to verify changes

## Files to Update

### Core Implementation
- `packages/epicenter/src/core/db/table-helper.ts`
- `packages/epicenter/src/index.ts`

### Usages (get)
- `examples/basic-workspace/epicenter.config.ts`
- `examples/content-hub/browser/browser.workspace.ts`
- `examples/content-hub/clippings/clippings.workspace.ts`
- `packages/epicenter/src/core/db/core.test.ts`
- `packages/epicenter/src/core/db/core-types.test.ts`
- `packages/epicenter/src/cli/cli-end-to-end.test.ts`
- `packages/epicenter/src/core/workspace.test.ts`

### Usages (getAll -> getAllValid)
- `examples/stress-test/stress-test-mixed-workload.ts`
- `examples/stress-test/stress-test-read-at-scale.ts`
- `examples/content-hub/browser/browser.workspace.ts`
- `examples/content-hub/clippings/clippings.workspace.ts`
- `packages/epicenter/src/indexes/sqlite/sqlite-index.ts`

### Documentation
- `packages/epicenter/README.md`
