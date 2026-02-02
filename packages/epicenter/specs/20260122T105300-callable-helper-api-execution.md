# Callable Helper API Execution Plan

**Date:** 2026-01-22T10:53:00
**Completed:** 2026-01-22T10:55:00
**Status:** Complete
**Branch:** feat/callable-helper-api
**Parent Spec:** 20260122T103629-namespaced-helper-api.md

## Summary

Implements the callable helper API as specified. Converts tables, kv, and schema helpers from flat spreads to callable functions with properties.

## Files Modified

### Core Implementation (Phase 1) ✓

1. **`src/core/tables/create-tables.ts`**
   - [x] Convert to callable function pattern
   - [x] Remove `...tableHelpers` spread
   - [x] Remove `table()` accessor (function is now the accessor)
   - [x] Rename `clearAll()` → `clear()`
   - [x] Add `toJSON()`
   - [x] Update types

2. **`src/core/tables/table-helper.ts`**
   - [x] Rename `$inferRow` → `inferRow`

3. **`src/core/kv/core.ts`**
   - [x] Convert to callable function pattern
   - [x] Remove `...kvHelpers` spread
   - [x] Rename `clearAll()` → `clear()`
   - [x] Rename `defined()` → `all()`
   - [x] Add `has()` and `names()`
   - [x] Update types

4. **`src/core/kv/kv-helper.ts`**
   - [x] Rename `$inferValue` → `inferValue`

5. **`src/core/schema-helper/schema-helper.ts`**
   - [x] Convert `createTablesSchemaHelper` to callable
   - [ ] Convert `createKvSchemaHelper` to callable (skipped - not required per spec)
   - [x] Rename all `$raw` → `raw`
   - [x] Remove `table()` accessor (function is now the accessor)

### Test Updates (Phase 2) ✓

1. **`src/core/tables/create-tables.test.ts`**
   - [x] Update all `tables.posts` → `tables('posts')` (~75 replacements)
   - [x] Update `clearAll()` → `clear()`

2. **`src/core/tables/create-tables.crdt-sync.test.ts`**
   - [x] Update all table access patterns (~86 replacements)

3. **`src/core/tables/create-tables.offline-sync.test.ts`**
   - [x] Update all table access patterns (~41 replacements)

4. **`src/core/tables/create-tables.types.test.ts`**
   - [x] Update all table access patterns (~22 replacements)

5. **`src/core/kv/kv-helper.test.ts`**
   - [x] Update all `kv.theme` → `kv('theme')` (~103 replacements)
   - [x] Update `clearAll()` → `clear()`

6. **`src/core/schema-helper/schema-helper.test.ts`**
   - [x] Update `$raw` → `raw` (~12 replacements)
   - [x] Update `schema.tables.table('posts')` → `schema.tables('posts')`

### Call Site Updates (Phase 3) ✓

1. **`src/extensions/sqlite/sqlite.ts`**
   - [x] Update `tables.clearAll()` → `tables.clear()`

2. **`apps/tab-manager/src/entrypoints/background.ts`**
   - [x] Update `tables.tabs` → `tables('tabs')` (34 replacements)
   - [x] Update `tables.windows` → `tables('windows')`
   - [x] Update `tables.devices` → `tables('devices')`
   - [x] Update `tables.tab_groups` → `tables('tab_groups')`
   - [x] Update `client.tables.tabs` → `client.tables('tabs')`

## Implementation Strategy

### Phase 1: Core Implementation

Convert the core functions to callable patterns while maintaining backward compatibility for the intermediate state.

**Pattern for callable with properties:**

```typescript
type TablesFunction<TDef> = {
  // Call signatures
  <K extends keyof TDef>(name: K): TableHelper<TDef[K]['fields']>;
  (name: string): UntypedTableHelper;

  // Properties
  has(name: string): boolean;
  names(): string[];
  all(): UntypedTableHelper[];
  // ...
};

function createTables<TDef>(...): TablesFunction<TDef> {
  const accessor = (name: string) => { /* ... */ };

  // Attach properties
  accessor.has = (name: string) => { /* ... */ };
  accessor.names = () => { /* ... */ };
  // ...

  return accessor as TablesFunction<TDef>;
}
```

### Phase 2: Test Updates

Use AST-grep or find/replace to update test files:

- `tables\.(\w+)\.` → `tables('$1').`
- `kv\.(\w+)\.` → `kv('$1').`
- `clearAll()` → `clear()`
- `$inferRow` → `inferRow`
- `$inferValue` → `inferValue`
- `$raw` → `raw`

### Phase 3: Call Site Updates

Update all consuming code in apps and extensions.

## Rollback Plan

All changes are on `feat/callable-helper-api` branch. If issues arise:

```bash
git checkout feat/epicenter-app
```

## Testing Strategy

1. Run `bun test` after each phase
2. Verify type inference works correctly
3. Check that all call sites compile

## Review Checklist

- [x] All tests pass (349 pass, 2 skip, 0 fail)
- [x] Types are correct (no `any` usage)
- [ ] README.md examples updated (not done - out of scope)
- [x] No regressions in existing functionality

## Implementation Notes

### Bug Fix: Object.assign Evaluates Getters Eagerly

When using `Object.assign` to attach properties to a callable function, any getter properties are evaluated immediately during the assignment. This caused the `raw` getter on `createTablesSchemaHelper` to be called during initialization, which created an empty `tables` Y.Map.

**Problem:**

```typescript
return Object.assign(fn, {
	get raw() {
		return getOrCreateTablesMap();
	}, // Evaluated immediately!
});
```

**Solution:**
Use `Object.defineProperty` for getters to preserve lazy evaluation:

```typescript
const result = Object.assign(fn, {
	/* methods */
});
Object.defineProperty(result, 'raw', {
	get() {
		return getOrCreateTablesMap();
	},
	enumerable: true,
	configurable: true,
});
return result;
```

### API Changes Summary

| Before                         | After                         |
| ------------------------------ | ----------------------------- |
| `tables.posts.upsert(...)`     | `tables('posts').upsert(...)` |
| `tables.table('posts')`        | `tables('posts')`             |
| `tables.clearAll()`            | `tables.clear()`              |
| `tables.posts.$inferRow`       | `tables('posts').inferRow`    |
| `kv.theme.set(...)`            | `kv('theme').set(...)`        |
| `kv.clearAll()`                | `kv.clear()`                  |
| `kv.defined()`                 | `kv.all()`                    |
| `kv.theme.$inferValue`         | `kv('theme').inferValue`      |
| `schema.tables.table('posts')` | `schema.tables('posts')`      |
| `schema.tables.$raw`           | `schema.tables.raw`           |
| `schema.$raw`                  | `schema.raw`                  |
