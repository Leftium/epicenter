# Variadic `defineTable` / `defineKv` — Replace `.version()` Chaining with Rest Parameters

**Date:** 2026-03-03
**Status:** In Progress
**Author:** braden
**Branch:** `braden-w/variadic-define-table-kv`

## Overview

Replace the `.version()` builder chain on `defineTable()` and `defineKv()` with variadic rest parameters. The chaining gives no type inference benefit over rest params and adds unnecessary API surface (a `TableBuilder` / `KvBuilder` intermediate type).

## Motivation

### Current State

```typescript
const posts = defineTable()
  .version(type({ id: 'string', title: 'string', _v: '1' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
  .migrate((row) => {
    switch (row._v) {
      case 1: return { ...row, views: 0, _v: 2 as const };
      case 2: return row;
    }
  });
```

### Problems

1. **`.version()` chaining builds a tuple one element at a time, but TypeScript can infer the full tuple from a variadic rest parameter.** The sequential chaining gives zero type inference advantage — each `.version()` call is independent (it doesn't constrain the next call).

2. **The `TableBuilder` / `KvBuilder` types exist only to collect schemas.** This is exactly what rest parameters do natively. The builder types are extra API surface to maintain, export, and document.

3. **The `defineTable()` zero-arg overload returns a builder, not a definition.** This creates a confusing state where `defineTable()` on its own is incomplete — you must chain `.version().migrate()` to get a usable definition. With variadic, every call to `defineTable(...)` returns something meaningful.

### Desired State

```typescript
const posts = defineTable(
  type({ id: 'string', title: 'string', _v: '1' }),
  type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, _v: 2 as const };
    case 2: return row;
  }
});
```

Or with pre-declared schemas (recommended style for readability):

```typescript
const postV1 = type({ id: 'string', title: 'string', _v: '1' });
const postV2 = type({ id: 'string', title: 'string', views: 'number', _v: '2' });

const posts = defineTable(postV1, postV2).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, _v: 2 as const };
    case 2: return row;
  }
});
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `_v` management | User-managed (no change) | `_v` is already a convention, not infrastructure. Users include it in their schemas. No auto-injection. |
| Single-version shorthand | Keep `defineTable(schema)` returning a complete definition | This is the most common pattern (100% of production code). No `.migrate()` needed. |
| Multi-version API | `defineTable(s1, s2, ...sN).migrate(fn)` | Rest params give identical tuple inference. Eliminates `TableBuilder`/`KvBuilder` types. |
| `.withDocument()` chaining | Keep as-is on the result of both shorthand and `.migrate()` | Orthogonal to versioning. Already works well. |
| Zero-arg `defineTable()` | Remove | No longer needed. The zero-arg call was only the entry point for the builder chain. |
| Minimum version count for `.migrate()` | 2+ schemas required for the variadic overload | If you pass 1 schema, use the shorthand (no `.migrate()` needed). If you pass 2+, `.migrate()` is required. |

## Architecture

### Overload Structure for `defineTable`

```
defineTable(schema)                    → TableDefinitionWithDocBuilder<[TSchema], {}>
defineTable(s1, s2, ...sN)             → { migrate(fn) → TableDefinitionWithDocBuilder<TVersions, {}> }
```

```
┌─────────────────────────────────────────────────────┐
│ defineTable(schema)                                 │
│   1 arg → complete definition                       │
│   Returns: TableDefinitionWithDocBuilder             │
│            (has .withDocument())                     │
├─────────────────────────────────────────────────────┤
│ defineTable(s1, s2, ...sN)                          │
│   2+ args → needs .migrate()                        │
│   Returns: { migrate(fn) → TableDefinitionWithDocBuilder }│
│                                                     │
│   migrate(fn) receives union of all version outputs  │
│   migrate(fn) must return the last version's output  │
└─────────────────────────────────────────────────────┘
```

### Overload Structure for `defineKv`

Identical pattern, but without `BaseRow` constraint and without `.withDocument()`:

```
defineKv(schema)                       → KvDefinition<[TSchema]>
defineKv(s1, s2, ...sN)                → { migrate(fn) → KvDefinition<TVersions> }
```

### Types to Remove

- `TableBuilder<TVersions>` — replaced by the variadic overload's return type (inline `{ migrate(...) }`)
- `KvBuilder<TVersions>` — same

### Types to Keep (unchanged)

- `TableDefinition<TVersions, TDocuments>`
- `TableDefinitionWithDocBuilder<TVersions, TDocuments>`
- `KvDefinition<TVersions>`
- `LastSchema<T>`
- `BaseRow`
- All result types, helper types, etc.

## Implementation Plan

### Wave 1: Core API Changes (sequential — `defineTable` then `defineKv`)

- [x] **1.1** Rewrite `defineTable` in `packages/epicenter/src/workspace/define-table.ts`:
  - Remove the `TableBuilder` type
  - Remove the zero-arg `defineTable()` overload
  - Keep the single-arg `defineTable(schema)` overload (unchanged behavior)
  - Add a variadic overload: `defineTable<const TVersions extends [CombinedStandardSchema<BaseRow>, CombinedStandardSchema<BaseRow>, ...CombinedStandardSchema<BaseRow>[]]>(...versions: TVersions)` returning `{ migrate(fn): TableDefinitionWithDocBuilder<TVersions, Record<string, never>> }`
  - Implementation body: check `arguments.length === 1` for shorthand path; otherwise treat as variadic, call `createUnionSchema(versions)` in `.migrate()`
  - Update JSDoc and `@example` blocks in the file

- [x] **1.2** Rewrite `defineKv` in `packages/epicenter/src/workspace/define-kv.ts`:
  - Remove the `KvBuilder` type
  - Remove the zero-arg `defineKv()` overload
  - Keep the single-arg `defineKv(schema)` overload (unchanged behavior)
  - Add a variadic overload: `defineKv<const TVersions extends [CombinedStandardSchema, CombinedStandardSchema, ...CombinedStandardSchema[]]>(...versions: TVersions)` returning `{ migrate(fn): KvDefinition<TVersions> }`
  - Update JSDoc and `@example` blocks

### Wave 2: Update All Test Files (parallelizable)

Every `.version()` chain becomes variadic arguments. The migration functions stay identical.

- [ ] **2.1** Update `packages/epicenter/src/workspace/define-table.test.ts`
- [ ] **2.2** Update `packages/epicenter/src/workspace/define-kv.test.ts`
- [ ] **2.3** Update `packages/epicenter/src/workspace/create-tables.test.ts`
- [ ] **2.4** Update `packages/epicenter/src/workspace/create-kv.test.ts`
- [ ] **2.5** Update `packages/epicenter/src/workspace/table-helper.test.ts`
- [ ] **2.6** Update `packages/epicenter/src/workspace/describe-workspace.test.ts`
- [ ] **2.7** Update `packages/epicenter/src/workspace/create-workspace.test.ts`

**Transformation pattern for tests:**

```typescript
// Before
defineTable()
  .version(type({ id: 'string', title: 'string', _v: '1' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
  .migrate((row) => { ... });

// After
defineTable(
  type({ id: 'string', title: 'string', _v: '1' }),
  type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
).migrate((row) => { ... });
```

Same for `defineKv`:

```typescript
// Before
defineKv()
  .version(type({ mode: "'light' | 'dark'", _v: '1' }))
  .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }))
  .migrate((v) => { ... });

// After
defineKv(
  type({ mode: "'light' | 'dark'", _v: '1' }),
  type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }),
).migrate((v) => { ... });
```

### Wave 3: Verify

- [ ] **3.1** Run `bun test` across the workspace to confirm all tests pass
- [ ] **3.2** Run `bun run typecheck` to confirm no type errors
- [ ] **3.3** Run `bun run lint` and fix any issues

## Edge Cases

1. **Single schema passed to variadic overload**: TypeScript overload resolution handles this — single arg matches the first overload (shorthand), not the variadic. The variadic requires 2+ args via the tuple constraint `[S, S, ...S[]]`.

2. **`.withDocument()` after `.migrate()`**: Works identically. `.migrate()` returns `TableDefinitionWithDocBuilder` which has `.withDocument()`. No change needed.

3. **Pre-composed schemas (like `commandBase.merge(...)`)**: Still works — the result is a `CombinedStandardSchema` passed as a single arg to the shorthand overload. No change.

4. **KV with non-object schemas** (e.g., `defineKv(type('Record<string, string> | null'))`): Single-arg shorthand, unaffected.

5. **KV with field-presence migration (no `_v`)**: Still works — the migrate function receives the union type and can use `'field' in v` checks. No change to migration function signatures.

## Impact Assessment

**Production code: zero changes required.** Every production call site uses the single-version shorthand `defineTable(schema)` or `defineKv(schema)`, which is unchanged. The `.version()` builder is only used in test files.

**Test files: mechanical transformation.** Every `.version()` chain becomes variadic args. The migration functions are identical.

## Open Questions

1. **Should we also update the `@example` in `workspace-api` skill documentation?**
   - Recommendation: Yes, update `.agents/skills/workspace-api/SKILL.md` examples in the same PR.

2. **Should the variadic overload's return type be a named type or inline?**
   - Option A: Inline `{ migrate(fn): TableDefinitionWithDocBuilder<...> }` — fewer types to maintain.
   - Option B: Named `TableMigratable<TVersions>` — more discoverable in IDE.
   - Recommendation: Start with inline (Option A). Extract to named type only if the inline becomes unwieldy.

## Success Criteria

- [ ] `TableBuilder` and `KvBuilder` types no longer exist
- [ ] Zero-arg `defineTable()` and `defineKv()` overloads removed
- [ ] Single-arg shorthand works identically (no changes to production code)
- [ ] Multi-version `defineTable(s1, s2).migrate(fn)` works with correct type inference
- [ ] Multi-version `defineKv(s1, s2).migrate(fn)` works with correct type inference
- [ ] `.withDocument()` chaining works after both shorthand and `.migrate()`
- [ ] All existing tests pass (after mechanical transformation)
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

## References

- `packages/epicenter/src/workspace/define-table.ts` — `defineTable` implementation + `TableBuilder` type
- `packages/epicenter/src/workspace/define-kv.ts` — `defineKv` implementation + `KvBuilder` type
- `packages/epicenter/src/workspace/types.ts` — `TableDefinition`, `KvDefinition`, `LastSchema`, `BaseRow`
- `packages/epicenter/src/workspace/schema-union.ts` — `createUnionSchema` (unchanged)
- `packages/epicenter/src/workspace/define-table.test.ts` — primary test file for multi-version
- `packages/epicenter/src/workspace/define-kv.test.ts` — primary test file for multi-version KV
